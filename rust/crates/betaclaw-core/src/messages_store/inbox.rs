//! Port of `src/server/channels/messages/repository/queries/inbox.ts`.
//!
//! `listInbox` is the hot read path of the chat sidebar. Two details matter for
//! parity:
//!
//! * The "last message" is a correlated subquery on `idx_msg_conv_seq`
//!   (`conversation_id, seq`) instead of a join over the whole `messages`
//!   table, so the engine never scans messages of other users.
//! * `COUNT(*) OVER()` returns the total match count *before* `LIMIT`, so the
//!   UI can show "showing 50 of 812" without a second query. It therefore reads
//!   the window value from the first returned row; an empty result reports `0`.

use rusqlite::types::Value as SqlValue;
use rusqlite::{params_from_iter, Connection, OptionalExtension};

use super::trace::{log_inbox_db_query, QueryTimer};
use super::types::{
    normalize_user_id, InboxCursor, InboxItemRecord, InboxLastMessage, InboxListInput,
    InboxListResult, MessageRepositoryError,
};

/// `InboxRow` from `inbox.ts:11-22`.
struct InboxRow {
    conversation_id: String,
    channel_type: String,
    title: String,
    updated_at: String,
    last_message_id: Option<String>,
    last_message_role: Option<String>,
    last_message_content: Option<String>,
    last_message_created_at: Option<String>,
    last_message_platform: Option<String>,
    total_matched: Option<i64>,
}

impl InboxRow {
    fn map(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            conversation_id: row.get("conversation_id")?,
            channel_type: row.get("channel_type")?,
            title: row.get("title")?,
            updated_at: row.get("updated_at")?,
            last_message_id: row.get("last_message_id")?,
            last_message_role: row.get("last_message_role")?,
            last_message_content: row.get("last_message_content")?,
            last_message_created_at: row.get("last_message_created_at")?,
            last_message_platform: row.get("last_message_platform")?,
            // `getInboxItem` (`inbox.ts:135-183`) selects no `total_matched`.
            // The TypeScript interface still declares the field, but nothing
            // reads it from that row, so here the column is optional and only
            // `listInbox` supplies it.
            total_matched: row.get::<_, Option<i64>>("total_matched").ok().flatten(),
        })
    }

    /// `toInboxItem` from `inbox.ts:185-201`.
    ///
    /// The `|| fallback` expressions are reproduced with `unwrap_or`, except the
    /// role: TypeScript casts the possibly-`NULL` role and defaults it to
    /// `'user'` only in the sense that a `NULL` becomes the literal `"null"` in
    /// JavaScript when interpolated. The column is `NOT NULL CHECK(role IN (...))`,
    /// so the difference is unreachable; the port defaults to `user`.
    fn to_inbox_item(&self) -> InboxItemRecord {
        let last_message = self.last_message_id.as_ref().map(|id| InboxLastMessage {
            id: id.clone(),
            role: self
                .last_message_role
                .clone()
                .filter(|role| !role.is_empty())
                .unwrap_or_else(|| "user".to_string()),
            content: self.last_message_content.clone().unwrap_or_default(),
            created_at: self
                .last_message_created_at
                .clone()
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| self.updated_at.clone()),
            platform: self
                .last_message_platform
                .clone()
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| self.channel_type.clone()),
        });

        InboxItemRecord {
            conversation_id: self.conversation_id.clone(),
            channel_type: self.channel_type.clone(),
            title: self.title.clone(),
            updated_at: self.updated_at.clone(),
            last_message,
        }
    }
}

/// `InboxQueries` from `inbox.ts:24`.
pub struct InboxQueries<'a> {
    db: &'a Connection,
}

impl<'a> InboxQueries<'a> {
    pub fn new(db: &'a Connection) -> Self {
        Self { db }
    }

    /// `listInbox` from `inbox.ts:30-133`.
    pub fn list_inbox(
        &self,
        input: &InboxListInput<'_>,
    ) -> Result<InboxListResult, MessageRepositoryError> {
        let user_id = normalize_user_id(Some(input.user_id));
        let limit = input
            .limit
            .filter(|value| *value != 0)
            .unwrap_or(50)
            .clamp(1, 100);
        let channel = input.channel.unwrap_or_default().trim().to_lowercase();
        let query = input.query.unwrap_or_default().trim().to_lowercase();
        let like_query = format!("%{query}%");
        let cursor_updated_at = input
            .cursor
            .as_ref()
            .map(|cursor| cursor.updated_at.trim())
            .unwrap_or_default();
        let cursor_conversation_id = input
            .cursor
            .as_ref()
            .map(|cursor| cursor.conversation_id.trim())
            .unwrap_or_default();

        // Correlated subquery on idx_msg_conv_seq (conversation_id, seq) — only
        // touches rows for the conversations already filtered by user_id, so the
        // engine never scans the full messages table.
        let timer = QueryTimer::start();
        let binds: Vec<SqlValue> = vec![
            user_id.as_str().to_owned().into(),
            channel.as_str().to_owned().into(),
            channel.as_str().to_owned().into(),
            query.as_str().to_owned().into(),
            like_query.as_str().to_owned().into(),
            like_query.as_str().to_owned().into(),
            cursor_updated_at.to_owned().into(),
            cursor_updated_at.to_owned().into(),
            cursor_updated_at.to_owned().into(),
            cursor_conversation_id.to_owned().into(),
            (limit + 1).into(),
        ];

        let mut statement = self.db.prepare(
            "
        SELECT
          c.id AS conversation_id,
          c.channel_type,
          c.title,
          c.updated_at,
          lm.id AS last_message_id,
          lm.role AS last_message_role,
          lm.content AS last_message_content,
          lm.created_at AS last_message_created_at,
          lm.platform AS last_message_platform,
          COUNT(*) OVER() AS total_matched
        FROM conversations c
        LEFT JOIN messages lm
          ON lm.id = (
            SELECT m.id
            FROM messages m
            WHERE m.conversation_id = c.id
            ORDER BY m.seq DESC
            LIMIT 1
          )
        WHERE c.user_id = ?1
          AND LOWER(TRIM(c.channel_type)) NOT IN ('agentroom', 'agent-room', 'agent_room')
          AND NOT EXISTS (
            SELECT 1
            FROM agent_room_swarms s
            WHERE s.conversation_id = c.id AND s.user_id = c.user_id
          )
          AND (?2 = '' OR LOWER(c.channel_type) = ?3)
          AND (?4 = '' OR LOWER(c.title) LIKE ?5 OR LOWER(COALESCE(lm.content, '')) LIKE ?6)
          AND (
            ?7 = ''
            OR c.updated_at < ?8
            OR (c.updated_at = ?9 AND c.id < ?10)
          )
        ORDER BY c.updated_at DESC, c.id DESC
        LIMIT ?11
        ",
        )?;
        let raw_rows = statement
            .query_map(params_from_iter(binds.iter()), InboxRow::map)?
            .collect::<Result<Vec<_>, _>>()?;

        let query_duration_ms = timer.elapsed_ms();
        log_inbox_db_query("inbox.list.main", query_duration_ms);

        let items: Vec<InboxItemRecord> = raw_rows
            .iter()
            .take(limit.max(0) as usize)
            .map(InboxRow::to_inbox_item)
            .collect();
        let has_more = raw_rows.len() as i64 > limit;
        let next_cursor = if has_more {
            items.last().map(|item| InboxCursor {
                updated_at: item.updated_at.clone(),
                conversation_id: item.conversation_id.clone(),
            })
        } else {
            None
        };

        // `COUNT(*) OVER()` is read off the first row, exactly like
        // `rows[0]?.total_matched || 0`.
        let total_matched = raw_rows
            .first()
            .and_then(|row| row.total_matched)
            .unwrap_or(0)
            .max(0);

        Ok(InboxListResult {
            items,
            limit,
            has_more,
            next_cursor,
            total_matched,
        })
    }

    /// `getInboxItem` from `inbox.ts:135-183`.
    pub fn get_inbox_item(
        &self,
        conversation_id: &str,
        user_id: &str,
    ) -> Result<Option<InboxItemRecord>, MessageRepositoryError> {
        let normalized_user_id = normalize_user_id(Some(user_id));
        let timer = QueryTimer::start();
        let mut statement = self.db.prepare(
            "
        SELECT
          c.id AS conversation_id,
          c.channel_type,
          c.title,
          c.updated_at,
          lm.id AS last_message_id,
          lm.role AS last_message_role,
          lm.content AS last_message_content,
          lm.created_at AS last_message_created_at,
          lm.platform AS last_message_platform
        FROM conversations c
        LEFT JOIN messages lm
          ON lm.id = (
            SELECT m.id
            FROM messages m
            WHERE m.conversation_id = c.id
            ORDER BY m.seq DESC
            LIMIT 1
          )
        WHERE c.id = ?1
          AND c.user_id = ?2
          AND LOWER(TRIM(c.channel_type)) NOT IN ('agentroom', 'agent-room', 'agent_room')
          AND NOT EXISTS (
            SELECT 1
            FROM agent_room_swarms s
            WHERE s.conversation_id = c.id AND s.user_id = c.user_id
          )
        LIMIT 1
        ",
        )?;
        let row = statement
            .query_row(
                rusqlite::params![conversation_id, normalized_user_id],
                InboxRow::map,
            )
            .optional()?;

        log_inbox_db_query("getItem.main", timer.elapsed_ms());

        Ok(row.as_ref().map(InboxRow::to_inbox_item))
    }
}
