//! Port of `src/server/channels/messages/repository/queries/delete.ts`.
//!
//! # FTS5 corruption recovery
//!
//! An external-content FTS5 table can go stale: rows deleted by a tool that
//! bypassed the triggers, a restored backup, or a `VACUUM` at the wrong moment
//! all leave the index inconsistent. SQLite then refuses the `DELETE` with
//! `database disk image is malformed` / `SQLITE_CORRUPT`. The TypeScript source
//! treats such an error as recoverable: it rebuilds the index and retries once.
//! [`is_corruption_error`] mirrors the substring test of `isCorruptionError`
//! (`delete.ts:9-12`) so a genuine error — a foreign-key violation, a locked
//! database — is still surfaced.
//!
//! # Tables owned by other slices
//!
//! `clearConversationDerivedState` deletes from four `knowledge_*` tables that
//! live in the same shared `messages.db` but are created by slice S7. The source
//! wraps each in a blanket `try {} catch {}`; the port ignores the same set of
//! errors rather than pretending those tables exist. See the module docs of
//! [`migrations`](crate::messages_store::migrations) for the shared-file
//! contract.
//!
//! `deleteMessage` deliberately leaves the knowledge tables alone — the comment
//! at `delete.ts:119-124` explains why, and that reasoning still holds.

use rusqlite::{params, Connection};

use super::types::{normalize_user_id, now_iso, MessageRepositoryError};

/// `isCorruptionError` from `delete.ts:9-12`.
fn is_corruption_error(message: &str) -> bool {
    message.contains("malformed") || message.contains("corrupt")
}

/// Knowledge tables cleared together with a conversation. Owned by slice S7.
const KNOWLEDGE_TABLES: [&str; 4] = [
    "knowledge_ingestion_checkpoints",
    "knowledge_episodes",
    "knowledge_meeting_ledger",
    "knowledge_retrieval_audit",
];

/// `DeleteQueries` from `delete.ts:3`.
pub struct DeleteQueries<'a> {
    db: &'a Connection,
}

impl<'a> DeleteQueries<'a> {
    pub fn new(db: &'a Connection) -> Self {
        Self { db }
    }

    /// `deleteMessagesByConversation` from `delete.ts:14-25`.
    fn delete_messages_by_conversation(
        &self,
        conversation_id: &str,
    ) -> Result<(), MessageRepositoryError> {
        match self.db.execute(
            "DELETE FROM messages WHERE conversation_id = ?1",
            params![conversation_id],
        ) {
            Ok(_) => Ok(()),
            Err(error) if is_corruption_error(&error.to_string()) => {
                self.rebuild_fts()?;
                self.db.execute(
                    "DELETE FROM messages WHERE conversation_id = ?1",
                    params![conversation_id],
                )?;
                Ok(())
            }
            Err(error) => Err(error.into()),
        }
    }

    /// `deleteSingleMessage` from `delete.ts:27-59`.
    fn delete_single_message(
        &self,
        message_id: &str,
        normalized_user_id: &str,
    ) -> Result<usize, MessageRepositoryError> {
        let sql = "
          DELETE FROM messages
          WHERE id = ?1
            AND conversation_id IN (
              SELECT id FROM conversations WHERE user_id = ?2
            )
        ";
        match self
            .db
            .execute(sql, params![message_id, normalized_user_id])
        {
            Ok(changes) => Ok(changes),
            Err(error) if is_corruption_error(&error.to_string()) => {
                self.rebuild_fts()?;
                Ok(self
                    .db
                    .execute(sql, params![message_id, normalized_user_id])?)
            }
            Err(error) => Err(error.into()),
        }
    }

    /// `INSERT INTO messages_fts(messages_fts) VALUES('rebuild')`.
    fn rebuild_fts(&self) -> Result<(), MessageRepositoryError> {
        self.db
            .execute_batch("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')")?;
        Ok(())
    }

    /// `clearConversationDerivedState` from `delete.ts:61-77`.
    fn clear_conversation_derived_state(
        &self,
        conversation_id: &str,
    ) -> Result<(), MessageRepositoryError> {
        self.db.execute(
            "DELETE FROM conversation_context WHERE conversation_id = ?1",
            params![conversation_id],
        )?;
        for table in KNOWLEDGE_TABLES {
            // `catch {}` in the source: the table may not exist in a test or
            // memory database, and an S7 deployment owns those rows.
            let statement = format!("DELETE FROM \"{table}\" WHERE conversation_id = ?1");
            match self.db.execute(&statement, params![conversation_id]) {
                Ok(_) => {}
                Err(error) => tracing::debug!(
                    scope = "messages.delete",
                    table,
                    error = %crate::safe_error_message(&error),
                    "skipping knowledge table that is not present in this database"
                ),
            }
        }
        Ok(())
    }

    /// `deleteConversation` from `delete.ts:79-106`.
    ///
    /// The caller resolves the ownership guard first (see
    /// [`MessagesStore::delete_conversation`](crate::messages_store::repository::MessagesStore::delete_conversation)).
    pub fn delete_conversation(
        &self,
        id: &str,
        user_id: &str,
    ) -> Result<bool, MessageRepositoryError> {
        let normalized_user_id = normalize_user_id(Some(user_id));

        self.delete_messages_by_conversation(id)?;

        // Delete context + knowledge artefacts + conversation
        self.clear_conversation_derived_state(id)?;
        for table in ["agent_room_swarms", "conversation_project_state"] {
            // `catch {}` in the source: legacy and isolated test databases do
            // not necessarily have these tables.
            let statement = format!("DELETE FROM {table} WHERE conversation_id = ?1");
            match self.db.execute(&statement, params![id]) {
                Ok(_) => {}
                Err(error) => tracing::debug!(
                    scope = "messages.delete",
                    table,
                    error = %crate::safe_error_message(&error),
                    "skipping table that is not present in this database"
                ),
            }
        }
        self.db.execute(
            "DELETE FROM conversations WHERE id = ?1 AND user_id = ?2",
            params![id, normalized_user_id],
        )?;
        Ok(true)
    }

    /// `deleteMessage` from `delete.ts:108-132`.
    ///
    /// Only the runtime context cache is invalidated. Knowledge tables (episodes,
    /// meeting_ledger, retrieval_audit) must NOT be cleared here — deleting one
    /// message does not invalidate knowledge extracted from other messages in the
    /// same conversation. Clearing them would also cause a full-table-scan on
    /// knowledge_retrieval_audit and destroy legitimate knowledge data.
    pub fn delete_message(
        &self,
        id: &str,
        user_id: &str,
        conversation_id: &str,
    ) -> Result<bool, MessageRepositoryError> {
        let normalized_user_id = normalize_user_id(Some(user_id));
        let deleted_rows = self.delete_single_message(id, &normalized_user_id)?;
        if deleted_rows == 0 {
            return Ok(false);
        }

        self.db.execute(
            "DELETE FROM conversation_context WHERE conversation_id = ?1",
            params![conversation_id],
        )?;
        self.db.execute(
            "UPDATE conversations SET updated_at = ?1 WHERE id = ?2 AND user_id = ?3",
            params![now_iso(), conversation_id, normalized_user_id],
        )?;
        Ok(true)
    }
}
