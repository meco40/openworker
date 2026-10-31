//! Port of `src/server/channels/messages/repository/queries/context.ts`.
//!
//! # The callback that disappeared
//!
//! `ContextQueries` receives a `getConversation` callback from
//! `SqliteMessageRepository` (`sqliteMessageRepository.ts:167-187`) because the
//! TypeScript modules form a cycle: context needs conversations, conversations
//! need nothing. Rust resolves the cycle statically, so the facade performs the
//! ownership check itself and these two methods are the pure statements:
//! [`ContextQueries::get_conversation_context`] and
//! [`ContextQueries::upsert_conversation_context`].
//! [`MessagesStore`](crate::messages_store::repository::MessagesStore) is the
//! composition point that reproduces the guard:
//!
//! * read — unknown or foreign conversation returns `None`, exactly like
//!   `getConversationContext`;
//! * write — unknown or foreign conversation raises
//!   [`MessageRepositoryError::ConversationNotFoundForContext`], exactly like
//!   `throw new Error('Conversation not found for context update.')`.

use rusqlite::{params, Connection, OptionalExtension};

use super::types::{now_iso, ConversationContextState, MessageRepositoryError};

/// `ContextQueries` from `context.ts:5`.
pub struct ContextQueries<'a> {
    db: &'a Connection,
}

impl<'a> ContextQueries<'a> {
    pub fn new(db: &'a Connection) -> Self {
        Self { db }
    }

    /// The `SELECT * FROM conversation_context` half of `getConversationContext`
    /// (`context.ts:18-38`).
    pub fn get_conversation_context(
        &self,
        conversation_id: &str,
    ) -> Result<Option<ConversationContextState>, MessageRepositoryError> {
        self.db
            .query_row(
                "SELECT * FROM conversation_context WHERE conversation_id = ?1",
                params![conversation_id],
                |row| {
                    Ok(ConversationContextState {
                        conversation_id: row.get("conversation_id")?,
                        summary_text: row.get("summary_text")?,
                        summary_upto_seq: row.get("summary_upto_seq")?,
                        updated_at: row.get("updated_at")?,
                    })
                },
            )
            .optional()
            .map_err(Into::into)
    }

    /// The statement half of `upsertConversationContext`
    /// (`context.ts:53-74`).
    pub fn upsert_conversation_context(
        &self,
        conversation_id: &str,
        summary_text: &str,
        summary_upto_seq: i64,
    ) -> Result<ConversationContextState, MessageRepositoryError> {
        let now = now_iso();
        self.db.execute(
            "
            INSERT INTO conversation_context (conversation_id, summary_text, summary_upto_seq, updated_at)
            VALUES (?1, ?2, ?3, ?4)
            ON CONFLICT(conversation_id)
            DO UPDATE SET
              summary_text = excluded.summary_text,
              summary_upto_seq = excluded.summary_upto_seq,
              updated_at = excluded.updated_at
          ",
            params![conversation_id, summary_text, summary_upto_seq, now],
        )?;

        Ok(ConversationContextState {
            conversation_id: conversation_id.to_string(),
            summary_text: summary_text.to_string(),
            summary_upto_seq,
            updated_at: now,
        })
    }
}
