//! Port of `src/server/knowledge/repositories/summaryRepository.ts`.
//!
//! | TypeScript member                                     | Rust member |
//! | ----------------------------------------------------- | ----------- |
//! | `summaryRepository.ts:9` (class)                       | [`SummaryRepository`] |
//! | `summaryRepository.ts:12-100` (`upsertConversationSummary`) | [`SummaryRepository::upsert_conversation_summary`] |
//! | `summaryRepository.ts:102-143` (`listConversationSummaries`) | [`SummaryRepository::list_conversation_summaries`] |
//!
//! # JavaScript semantics that are reproduced explicitly
//!
//! * The id is `` `csm-${Date.now()}-${crypto.randomBytes(4).toString('hex')}` ``.
//! * The update branch keeps the stored `created_at` and returns the fresh
//!   `updated_at`; the insert branch reports both as `now`.
//! * `emotionalTone` is `row.emotional_tone ? String(row.emotional_tone) : null`
//!   on read — an empty string is therefore `null`, while the write path stores
//!   the input verbatim.
//! * `Math.max(1, filter.limit || 50)`: a stored `0` is falsy and selects the `50`
//!   default *before* the `Math.max(1, …)` clamp.

use rusqlite::params_from_iter;
use rusqlite::types::Value;
use rusqlite::{params, Connection, OptionalExtension};

use super::{js_now_millis, parse_json_array, random_hex, KnowledgeRepositoryError};
use crate::knowledge::repository::{
    ConversationSummaryEntry, ListConversationSummariesFilter, UpsertConversationSummaryInput,
};

/// `SummaryRepository` from `summaryRepository.ts:9`.
pub struct SummaryRepository<'a> {
    db: &'a Connection,
}

impl<'a> SummaryRepository<'a> {
    pub fn new(db: &'a Connection) -> Self {
        Self { db }
    }

    /// `upsertConversationSummary` from `summaryRepository.ts:12-100`.
    pub fn upsert_conversation_summary(
        &self,
        input: &UpsertConversationSummaryInput,
    ) -> Result<ConversationSummaryEntry, KnowledgeRepositoryError> {
        let now = super::now_iso();
        let id = format!("csm-{}-{}", js_now_millis(), random_hex(4));

        let existing = self
            .db
            .query_row(
                "SELECT id, created_at FROM knowledge_conversation_summaries
                 WHERE conversation_id = ? AND persona_id = ?",
                params![input.conversation_id, input.persona_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
            )
            .optional()?;

        if let Some((existing_id, created_at)) = existing {
            self.db.execute(
                "UPDATE knowledge_conversation_summaries
                 SET summary_text = ?, key_topics_json = ?, entities_json = ?,
                     emotional_tone = ?, message_count = ?,
                     time_range_start = ?, time_range_end = ?, updated_at = ?
                 WHERE id = ?",
                params![
                    input.summary_text,
                    serde_json::to_string(&input.key_topics)?,
                    serde_json::to_string(&input.entities_mentioned)?,
                    input.emotional_tone,
                    input.message_count,
                    input.time_range_start,
                    input.time_range_end,
                    now,
                    existing_id
                ],
            )?;

            return Ok(ConversationSummaryEntry {
                id: existing_id,
                user_id: input.user_id.clone(),
                persona_id: input.persona_id.clone(),
                conversation_id: input.conversation_id.clone(),
                summary_text: input.summary_text.clone(),
                key_topics: input.key_topics.clone(),
                entities_mentioned: input.entities_mentioned.clone(),
                emotional_tone: input.emotional_tone.clone(),
                message_count: input.message_count,
                time_range_start: input.time_range_start.clone(),
                time_range_end: input.time_range_end.clone(),
                created_at: created_at.unwrap_or_default(),
                updated_at: now,
            });
        }

        self.db.execute(
            "INSERT INTO knowledge_conversation_summaries
             (id, user_id, persona_id, conversation_id, summary_text,
              key_topics_json, entities_json, emotional_tone, message_count,
              time_range_start, time_range_end, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                id,
                input.user_id,
                input.persona_id,
                input.conversation_id,
                input.summary_text,
                serde_json::to_string(&input.key_topics)?,
                serde_json::to_string(&input.entities_mentioned)?,
                input.emotional_tone,
                input.message_count,
                input.time_range_start,
                input.time_range_end,
                now,
                now
            ],
        )?;

        Ok(ConversationSummaryEntry {
            id,
            user_id: input.user_id.clone(),
            persona_id: input.persona_id.clone(),
            conversation_id: input.conversation_id.clone(),
            summary_text: input.summary_text.clone(),
            key_topics: input.key_topics.clone(),
            entities_mentioned: input.entities_mentioned.clone(),
            emotional_tone: input.emotional_tone.clone(),
            message_count: input.message_count,
            time_range_start: input.time_range_start.clone(),
            time_range_end: input.time_range_end.clone(),
            created_at: now.clone(),
            updated_at: now,
        })
    }

    /// `listConversationSummaries` from `summaryRepository.ts:102-143`.
    pub fn list_conversation_summaries(
        &self,
        filter: &ListConversationSummariesFilter,
    ) -> Result<Vec<ConversationSummaryEntry>, KnowledgeRepositoryError> {
        let mut conditions = vec!["user_id = ?".to_string(), "persona_id = ?".to_string()];
        let mut values = vec![
            Value::Text(filter.user_id.clone()),
            Value::Text(filter.persona_id.clone()),
        ];
        if let Some(conversation_id) = filter.conversation_id.as_deref() {
            conditions.push("conversation_id = ?".to_string());
            values.push(Value::Text(conversation_id.to_string()));
        }

        // `Math.max(1, filter.limit || 50)`: `0` is falsy and selects `50`.
        let raw_limit = match filter.limit {
            None | Some(0) => 50,
            Some(limit) => limit,
        };
        values.push(Value::Integer(raw_limit.max(1)));

        let sql = format!(
            "SELECT * FROM knowledge_conversation_summaries
             WHERE {}
             ORDER BY updated_at DESC
             LIMIT ?",
            conditions.join(" AND ")
        );
        let mut statement = self.db.prepare(&sql)?;
        let rows = statement.query_map(params_from_iter(values), read_summary_row)?;
        let mut entries = Vec::new();
        for row in rows {
            let row = row?;
            entries.push(ConversationSummaryEntry {
                id: row.id,
                user_id: row.user_id,
                persona_id: row.persona_id,
                conversation_id: row.conversation_id,
                summary_text: row.summary_text,
                key_topics: parse_json_array(row.key_topics_json.as_deref()),
                entities_mentioned: parse_json_array(row.entities_json.as_deref()),
                // `row.emotional_tone ? String(row.emotional_tone) : null`.
                emotional_tone: row.emotional_tone.filter(|value| !value.is_empty()),
                message_count: row.message_count.unwrap_or(0),
                time_range_start: row.time_range_start,
                time_range_end: row.time_range_end,
                created_at: row.created_at.unwrap_or_default(),
                updated_at: row.updated_at.unwrap_or_default(),
            });
        }
        Ok(entries)
    }
}

/// The columns of a `knowledge_conversation_summaries` row, before the list
/// reader maps them exactly like the TypeScript.
struct SummaryRow {
    id: String,
    user_id: String,
    persona_id: String,
    conversation_id: String,
    summary_text: String,
    key_topics_json: Option<String>,
    entities_json: Option<String>,
    emotional_tone: Option<String>,
    message_count: Option<i64>,
    time_range_start: String,
    time_range_end: String,
    created_at: Option<String>,
    updated_at: Option<String>,
}

/// Reads the `SELECT *` projection by position, matching the table column order
/// declared in [`super::migrations`].
fn read_summary_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SummaryRow> {
    Ok(SummaryRow {
        id: row.get(0)?,
        user_id: row.get(1)?,
        persona_id: row.get(2)?,
        conversation_id: row.get(3)?,
        summary_text: row.get(4)?,
        key_topics_json: row.get(5)?,
        entities_json: row.get(6)?,
        emotional_tone: row.get(7)?,
        message_count: row.get(8)?,
        time_range_start: row.get(9)?,
        time_range_end: row.get(10)?,
        created_at: row.get(11)?,
        updated_at: row.get(12)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{open, OpenOptions};
    use crate::knowledge::repositories::migrations::run_knowledge_migrations;

    fn connection() -> Connection {
        let connection = open(OpenOptions::new(":memory:")).expect("open");
        run_knowledge_migrations(&connection).expect("migrate");
        connection
    }

    fn input() -> UpsertConversationSummaryInput {
        UpsertConversationSummaryInput {
            user_id: "u-1".to_string(),
            persona_id: "p-1".to_string(),
            conversation_id: "c-1".to_string(),
            summary_text: "first summary".to_string(),
            key_topics: vec!["planning".to_string()],
            entities_mentioned: vec!["Max".to_string()],
            emotional_tone: Some("calm".to_string()),
            message_count: 4,
            time_range_start: "2026-01-01T00:00:00.000Z".to_string(),
            time_range_end: "2026-01-02T00:00:00.000Z".to_string(),
        }
    }

    #[test]
    fn a_second_upsert_updates_in_place_and_keeps_created_at() {
        let connection = connection();
        let repo = SummaryRepository::new(&connection);

        let created = repo.upsert_conversation_summary(&input()).expect("insert");
        assert!(created.id.starts_with("csm-"));
        assert_eq!(created.created_at, created.updated_at);

        let mut second = input();
        second.summary_text = "second summary".to_string();
        second.emotional_tone = None;
        let updated = repo.upsert_conversation_summary(&second).expect("update");

        assert_eq!(updated.id, created.id);
        assert_eq!(updated.summary_text, "second summary");
        assert_eq!(updated.created_at, created.created_at);
        assert!(updated.emotional_tone.is_none());

        let rows: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM knowledge_conversation_summaries",
                [],
                |row| row.get(0),
            )
            .expect("count");
        assert_eq!(rows, 1);
    }

    #[test]
    fn list_defaults_to_fifty_and_orders_by_updated_at() {
        let connection = connection();
        let repo = SummaryRepository::new(&connection);
        connection
            .execute_batch(
                r#"
                INSERT INTO knowledge_conversation_summaries VALUES
                  ('s-1','u-1','p-1','c-1','older','[]','[]',NULL,0,'t','t','t','2026-01-01T00:00:00.000Z'),
                  ('s-2','u-1','p-1','c-2','newer','[]','[]','',0,'t','t','t','2026-02-01T00:00:00.000Z');
                "#,
            )
            .expect("seed");

        let entries = repo
            .list_conversation_summaries(&ListConversationSummariesFilter {
                user_id: "u-1".to_string(),
                persona_id: "p-1".to_string(),
                conversation_id: None,
                limit: None,
            })
            .expect("list");
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].id, "s-2", "newest first");
        assert!(entries[0].emotional_tone.is_none(), "'' reads as null");

        let filtered = repo
            .list_conversation_summaries(&ListConversationSummariesFilter {
                user_id: "u-1".to_string(),
                persona_id: "p-1".to_string(),
                conversation_id: Some("c-1".to_string()),
                limit: Some(0),
            })
            .expect("list");
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].id, "s-1");
    }
}
