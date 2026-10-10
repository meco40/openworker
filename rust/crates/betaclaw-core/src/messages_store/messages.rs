//! Port of `src/server/channels/messages/repository/queries/messages.ts`.
//!
//! | TypeScript member                | Rust member                                          |
//! | -------------------------------- | --------------------------------------------------- |
//! | `saveMessage`                    | [`MessageQueries::save_message`]                     |
//! | `getMessage`                     | [`MessageQueries::get_message`]                      |
//! | `listMessages`                   | [`MessageQueries::list_messages`]                    |
//! | `listMessagesAfterSeq`           | [`MessageQueries::list_messages_after_seq`]          |
//! | `findMessageByClientId`          | [`MessageQueries::find_message_by_client_id`]        |
//! | `markMessagesMemoryPending`      | [`MessageQueries::mark_messages_memory_pending`]     |
//!
//! `markMessagesMemoryPending` wraps its loop in `db.transaction(...)`.
//! `rusqlite` has no transaction combinator, so the port issues an explicit
//! `BEGIN IMMEDIATE` / `COMMIT` pair with a rollback on error — the same
//! pattern `personas/repository.rs` uses.

use std::collections::HashMap;

use rusqlite::types::Value as SqlValue;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension};
use serde_json::Value;

use super::row_mappers::to_message;
use super::trace::{log_inbox_db_query, QueryTimer};
use super::types::{
    normalize_user_id, now_iso, MessageRepositoryError, SaveMessageInput, StoredMessage,
};

/// `MessageQueries` from `messages.ts:7`.
pub struct MessageQueries<'a> {
    db: &'a Connection,
}

impl<'a> MessageQueries<'a> {
    pub fn new(db: &'a Connection) -> Self {
        Self { db }
    }

    /// `saveMessage` from `messages.ts:13-57`.
    pub fn save_message(
        &self,
        input: &SaveMessageInput<'_>,
    ) -> Result<StoredMessage, MessageRepositoryError> {
        // Idempotency: if clientMessageId is provided, check for existing message
        if let Some(client_message_id) = input.client_message_id.filter(|value| !value.is_empty()) {
            if let Some(existing) =
                self.find_message_by_client_id(input.conversation_id, client_message_id)?
            {
                return Ok(existing);
            }
        }

        let id = new_message_id();
        let now = now_iso();
        let max_seq: Option<i64> = self.db.query_row(
            "SELECT COALESCE(MAX(seq), 0) as max_seq FROM messages WHERE conversation_id = ?1",
            params![input.conversation_id],
            |row| row.get("max_seq"),
        )?;
        let next_seq = max_seq.unwrap_or(0) + 1;
        let metadata = input
            .metadata
            .map(|value| {
                serde_json::to_string(value)
                    .map_err(|error| MessageRepositoryError::Json(error.to_string()))
            })
            .transpose()?;

        self.db.execute(
            "
            INSERT INTO messages (id, conversation_id, seq, role, content, platform, external_msg_id, sender_name, metadata, client_message_id, created_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
          ",
            params![
                id,
                input.conversation_id,
                next_seq,
                input.role.as_str(),
                input.content,
                input.platform,
                input.external_msg_id.filter(|value| !value.is_empty()),
                input.sender_name.filter(|value| !value.is_empty()),
                metadata,
                input.client_message_id.filter(|value| !value.is_empty()),
                now
            ],
        )?;

        self.db.execute(
            "UPDATE conversations SET updated_at = ?1 WHERE id = ?2",
            params![now, input.conversation_id],
        )?;

        self.db
            .query_row(
                "SELECT * FROM messages WHERE id = ?1",
                params![id],
                to_message,
            )
            .map_err(Into::into)
    }

    /// `getMessage` from `messages.ts:59-77`.
    pub fn get_message(
        &self,
        id: &str,
        user_id: Option<&str>,
    ) -> Result<Option<StoredMessage>, MessageRepositoryError> {
        let normalized_user_id = user_id.map(|value| normalize_user_id(Some(value)));
        let message = match normalized_user_id.as_deref() {
            Some(user_id) => self
                .db
                .query_row(
                    "
                    SELECT m.*
                    FROM messages m
                    JOIN conversations c ON c.id = m.conversation_id
                    WHERE m.id = ?1 AND c.user_id = ?2
                    LIMIT 1
                    ",
                    params![id, user_id],
                    to_message,
                )
                .optional()?,
            None => self
                .db
                .query_row(
                    "SELECT * FROM messages WHERE id = ?1 LIMIT 1",
                    params![id],
                    to_message,
                )
                .optional()?,
        };
        Ok(message)
    }

    /// `listMessages` from `messages.ts:79-176`.
    ///
    /// `before` is a cursor, not a timestamp: a purely numeric value is treated
    /// as a `seq` bound, anything else as a `created_at` bound. The result is
    /// always ascending by `seq`, because the queries run `ORDER BY seq DESC`
    /// and then reverse.
    pub fn list_messages(
        &self,
        conversation_id: &str,
        limit: i64,
        before: Option<&str>,
        user_id: Option<&str>,
    ) -> Result<Vec<StoredMessage>, MessageRepositoryError> {
        let timer = QueryTimer::start();
        let normalized_user_id = user_id.map(|value| normalize_user_id(Some(value)));
        let before_seq = before
            .filter(|value| is_ascii_digits(value))
            .and_then(|value| value.parse::<i64>().ok());

        let (sql, mut binds): (&str, Vec<SqlValue>) = match normalized_user_id.as_deref() {
            Some(scoped_user_id) => match (before_seq, before) {
                (Some(seq), _) => (
                    "
                    SELECT m.*
                    FROM messages m
                    JOIN conversations c ON c.id = m.conversation_id
                    WHERE m.conversation_id = ?1 AND m.seq < ?2 AND c.user_id = ?3
                    ORDER BY m.seq DESC
                    LIMIT ?4
                    ",
                    vec![conversation_id.to_owned().into(), seq.into(), scoped_user_id.to_owned().into()],
                ),
                (None, Some(before)) => (
                    "
                    SELECT m.*
                    FROM messages m
                    JOIN conversations c ON c.id = m.conversation_id
                    WHERE m.conversation_id = ?1 AND m.created_at < ?2 AND c.user_id = ?3
                    ORDER BY m.seq DESC
                    LIMIT ?4
                    ",
                    vec![conversation_id.to_owned().into(), before.to_owned().into(), scoped_user_id.to_owned().into()],
                ),
                (None, None) => (
                    "
                    SELECT m.*
                    FROM messages m
                    JOIN conversations c ON c.id = m.conversation_id
                    WHERE m.conversation_id = ?1 AND c.user_id = ?2
                    ORDER BY m.seq DESC
                    LIMIT ?3
                    ",
                    vec![conversation_id.to_owned().into(), scoped_user_id.to_owned().into()],
                ),
            },
            None => match (before_seq, before) {
                (Some(seq), _) => (
                    "SELECT * FROM messages WHERE conversation_id = ?1 AND seq < ?2 ORDER BY seq DESC LIMIT ?3",
                    vec![conversation_id.to_owned().into(), seq.into()],
                ),
                (None, Some(before)) => (
                    "SELECT * FROM messages WHERE conversation_id = ?1 AND created_at < ?2 ORDER BY seq DESC LIMIT ?3",
                    vec![conversation_id.to_owned().into(), before.to_owned().into()],
                ),
                (None, None) => (
                    "SELECT * FROM messages WHERE conversation_id = ?1 ORDER BY seq DESC LIMIT ?2",
                    vec![conversation_id.to_owned().into()],
                ),
            },
        };

        let mode = match (before_seq.is_some(), before.is_some()) {
            (true, _) => "beforeSeq",
            (false, true) => "beforeCreatedAt",
            (false, false) => "latest",
        };

        binds.push(limit.into());
        let mut statement = self.db.prepare(sql)?;
        let rows: Vec<StoredMessage> = statement
            .query_map(params_from_iter(binds.iter()), to_message)?
            .collect::<Result<Vec<_>, _>>()?;

        log_inbox_db_query("messages.list", timer.elapsed_ms());
        tracing::debug!(
            scope = "chat.display",
            query = "messages.list",
            conversation_id,
            user_id = normalized_user_id.as_deref().unwrap_or_default(),
            limit,
            mode,
            returned_rows = rows.len(),
            "message list"
        );

        Ok(rows.into_iter().rev().collect())
    }

    /// `listMessagesAfterSeq` from `messages.ts:178-216`.
    pub fn list_messages_after_seq(
        &self,
        conversation_id: &str,
        after_seq: i64,
        limit: i64,
        user_id: Option<&str>,
    ) -> Result<Vec<StoredMessage>, MessageRepositoryError> {
        let normalized_user_id = user_id.map(|value| normalize_user_id(Some(value)));
        let safe_after_seq = after_seq.max(0);
        let safe_limit = limit.clamp(1, 5000);

        let mut statement = self.db.prepare(match normalized_user_id.as_deref() {
            Some(_) => {
                "
                SELECT m.*
                FROM messages m
                JOIN conversations c ON c.id = m.conversation_id
                WHERE m.conversation_id = ?1 AND m.seq > ?2 AND c.user_id = ?3
                ORDER BY m.seq ASC
                LIMIT ?4
                "
            }
            None => {
                "
                SELECT *
                FROM messages
                WHERE conversation_id = ?1 AND seq > ?2
                ORDER BY seq ASC
                LIMIT ?3
                "
            }
        })?;

        let rows: Vec<StoredMessage> = match normalized_user_id.as_deref() {
            Some(user_id) => statement
                .query_map(
                    params![conversation_id, safe_after_seq, user_id, safe_limit],
                    to_message,
                )?
                .collect::<Result<Vec<_>, _>>()?,
            None => statement
                .query_map(
                    params![conversation_id, safe_after_seq, safe_limit],
                    to_message,
                )?
                .collect::<Result<Vec<_>, _>>()?,
        };
        Ok(rows)
    }

    /// `findMessageByClientId` from `messages.ts:218-223`.
    pub fn find_message_by_client_id(
        &self,
        conversation_id: &str,
        client_message_id: &str,
    ) -> Result<Option<StoredMessage>, MessageRepositoryError> {
        self.db
            .query_row(
                "SELECT * FROM messages WHERE conversation_id = ?1 AND client_message_id = ?2",
                params![conversation_id, client_message_id],
                to_message,
            )
            .optional()
            .map_err(Into::into)
    }

    /// `markMessagesMemoryPending` from `messages.ts:225-254`.
    ///
    /// Flips `metadata.memoryStatus` between `memory_pending` and `projected`
    /// for a batch of message ids and, on the pending path, records the
    /// projection error (truncated to 1000 characters) — the field the world
    /// model projector uses to report a failure back to the chat UI.
    pub fn mark_messages_memory_pending(
        &self,
        message_ids: &[&str],
        pending: bool,
        error_message: Option<&str>,
    ) -> Result<(), MessageRepositoryError> {
        let mut seen: HashMap<String, ()> = HashMap::new();
        let ids: Vec<&str> = message_ids
            .iter()
            .map(|id| id.trim())
            .filter(|id| !id.is_empty())
            .filter(|id| seen.insert((*id).to_string(), ()).is_none())
            .collect();
        if ids.is_empty() {
            return Ok(());
        }

        self.db.execute_batch("BEGIN IMMEDIATE")?;
        let outcome = (|| -> Result<(), MessageRepositoryError> {
            for id in ids {
                let existing: Option<Option<String>> = self
                    .db
                    .query_row(
                        "SELECT metadata FROM messages WHERE id = ?1",
                        params![id],
                        |row| row.get(0),
                    )
                    .optional()?;

                let Some(existing) = existing else { continue };

                let mut metadata = parse_metadata(existing.as_deref());
                if pending {
                    metadata.insert(
                        "memoryStatus".to_string(),
                        Value::String("memory_pending".to_string()),
                    );
                    if let Some(error_message) = error_message {
                        let truncated: String = error_message.chars().take(1000).collect();
                        metadata.insert(
                            "worldModelProjectionError".to_string(),
                            Value::String(truncated),
                        );
                    }
                } else {
                    metadata.insert(
                        "memoryStatus".to_string(),
                        Value::String("projected".to_string()),
                    );
                    metadata.remove("worldModelProjectionError");
                }

                self.db.execute(
                    "UPDATE messages SET metadata = ?1 WHERE id = ?2",
                    params![
                        serde_json::to_string(&metadata)
                            .map_err(|error| MessageRepositoryError::Json(error.to_string()))?,
                        id
                    ],
                )?;
            }
            Ok(())
        })();

        match outcome {
            Ok(()) => {
                self.db.execute_batch("COMMIT")?;
                Ok(())
            }
            Err(error) => {
                let _ = self.db.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    }
}

/// `JSON.parse(row.metadata)` with the same three-way fallback as
/// `messages.ts:234-244`: a non-object payload is replaced by an empty object,
/// and unparsable text is preserved under `legacyMetadata`.
/// Parses a stored `metadata` JSON value into an object map.
///
/// `src/server/channels/messages/repository/queries/messages.ts` guards every
/// write with a type check and falls back to an empty object, so the port
/// guarantees an object at the type level instead of checking at each call site.
/// A JSON value that parses but is not an object is treated as absent, and
/// unparseable text is preserved under `legacyMetadata`, exactly like the
/// TypeScript fallback.
fn parse_metadata(raw: Option<&str>) -> serde_json::Map<String, Value> {
    let Some(raw) = raw.filter(|value| !value.is_empty()) else {
        return serde_json::Map::new();
    };
    match serde_json::from_str::<Value>(raw) {
        Ok(Value::Object(map)) => map,
        Ok(_) => serde_json::Map::new(),
        Err(_) => {
            let mut map = serde_json::Map::new();
            map.insert("legacyMetadata".to_string(), Value::String(raw.to_string()));
            map
        }
    }
}

/// `/^\d+$/.test(value)` — JavaScript's `\d` is ASCII only.
fn is_ascii_digits(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit())
}

/// `msg-${Date.now()}-${crypto.randomUUID().slice(0, 8)}` from `messages.ts:20`.
fn new_message_id() -> String {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    let random = uuid::Uuid::new_v4().simple().to_string();
    format!("msg-{millis}-{}", &random[..8])
}
