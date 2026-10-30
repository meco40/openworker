//! Port of `src/server/channels/messages/repository/queries/search.ts`.
//!
//! The query is assembled from four optional filters, so both the `WHERE`
//! fragments and the bind vector grow together. The FTS5 expression is built by
//! [`build_fts_query`](crate::messages_store::fts::build_fts_query); when it
//! yields an empty string the `MATCH` clause is skipped entirely and the method
//! returns no rows, which is what keeps punctuation-only input from raising a
//! SQLite syntax error.
//!
//! `ORDER BY bm25(messages_fts) ASC` is the relevance ranking. Note that it
//! ranks by the *negative* bm25 score, so `ASC` returns the best match first.

use rusqlite::types::Value as SqlValue;
use rusqlite::{params_from_iter, Connection};

use super::fts::build_fts_query;
use super::row_mappers::to_message;
use super::trace::{log_chat_recall_completed, log_chat_recall_trace};
use super::types::{MessageRepositoryError, SearchMessagesOptions, StoredMessage};

/// `SearchQueries` from `search.ts:15`.
pub struct SearchQueries<'a> {
    db: &'a Connection,
}

impl<'a> SearchQueries<'a> {
    pub fn new(db: &'a Connection) -> Self {
        Self { db }
    }

    /// `searchMessages` from `search.ts:18-121`.
    pub fn search_messages(
        &self,
        query: &str,
        options: &SearchMessagesOptions<'_>,
    ) -> Result<Vec<StoredMessage>, MessageRepositoryError> {
        let trimmed = query.trim();
        if trimmed.is_empty() {
            return Ok(Vec::new());
        }

        let limit = options.limit.unwrap_or(50).clamp(1, 200);

        // Build FTS5 match expression — OR all tokens.
        let fts_query = build_fts_query(trimmed);
        if fts_query.is_empty() {
            log_chat_recall_trace("fts.query_skipped");
            return Ok(Vec::new());
        }

        let mut conditions: Vec<&str> = Vec::new();
        let mut binds: Vec<SqlValue> = vec![fts_query.into()];

        // `if (opts.userId)` and friends: an empty string adds no filter.
        if let Some(user_id) = options.user_id.filter(|value| !value.is_empty()) {
            conditions.push("c.user_id = ?");
            binds.push(user_id.to_owned().into());
        }
        if let Some(conversation_id) = options.conversation_id.filter(|value| !value.is_empty()) {
            conditions.push("m.conversation_id = ?");
            binds.push(conversation_id.to_owned().into());
        }
        if let Some(persona_id) = options.persona_id.filter(|value| !value.is_empty()) {
            conditions.push("c.persona_id = ?");
            binds.push(persona_id.to_owned().into());
        }
        if let Some(role) = options.role {
            conditions.push("m.role = ?");
            binds.push(role.as_str().to_owned().into());
        }

        let where_clause = if conditions.is_empty() {
            String::new()
        } else {
            format!("AND {}", conditions.join(" AND "))
        };
        let sql = format!(
            "
      SELECT m.*
      FROM messages_fts fts
      JOIN messages m ON m.rowid = fts.rowid
      JOIN conversations c ON c.id = m.conversation_id
      WHERE messages_fts MATCH ?
      {where_clause}
      ORDER BY bm25(messages_fts) ASC
      LIMIT ?
    "
        );
        binds.push(limit.into());

        let timer = crate::messages_store::trace::QueryTimer::start();
        let outcome = (|| -> rusqlite::Result<Vec<StoredMessage>> {
            let mut statement = self.db.prepare(&sql)?;
            let rows = statement.query_map(params_from_iter(binds.iter()), to_message)?;
            rows.collect::<Result<Vec<_>, _>>()
        })();

        match outcome {
            Ok(rows) => {
                log_chat_recall_completed(
                    timer.elapsed_ms(),
                    trimmed.chars().count(),
                    rows.len(),
                    limit,
                );
                Ok(rows)
            }
            Err(error) => {
                log_chat_recall_trace("fts.query_failed");
                tracing::error!(
                    scope = "chat.recall",
                    error = %crate::safe_error_message(&error),
                    "chat recall query failed"
                );
                Err(error.into())
            }
        }
    }
}
