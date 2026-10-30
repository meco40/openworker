//! Port of `src/server/knowledge/repositories/ledgerRepository.ts`.
//!
//! | TypeScript member                              | Rust member |
//! | ---------------------------------------------- | ----------- |
//! | `ledgerRepository.ts:10` (class)                | [`LedgerRepository`] |
//! | `ledgerRepository.ts:13-100` (`upsertMeetingLedger`) | [`LedgerRepository::upsert_meeting_ledger`] |
//! | `ledgerRepository.ts:102-139` (`listMeetingLedger`) | [`LedgerRepository::list_meeting_ledger`] |
//! | `ledgerRepository.ts:141-160` (`mapLedger`)     | [`LedgerRepository::map_ledger`] |
//!
//! # The `COALESCE(event_at, '')` key
//!
//! The lookup of the existing row compares `COALESCE(event_at, '') =
//! COALESCE(?, '')`, because SQLite treats two `NULL`s as distinct in a `UNIQUE`
//! index, while the writer wants a `NULL` event to match a `NULL` event. The
//! `ON CONFLICT(conversation_id, persona_id, topic_key, event_at)` clause then
//! uses the raw columns.
//!
//! The two halves do not cover each other: when the lookup matches a stored row
//! whose `event_at` is `NULL`, the reused id collides with the primary key and
//! SQLite raises `UNIQUE constraint failed: knowledge_meeting_ledger.id`
//! (`UNIQUE` sees two `NULL`s as distinct, so `DO UPDATE` never fires). That is
//! the TypeScript's own behaviour — same statement, same schema, same SQLite —
//! and the port keeps it; see `a_null_event_at_matches_a_null_event_at`.
//!
//! # Confidence
//!
//! `Number.isFinite(Number(input.confidence)) ? Math.max(0, Math.min(1, …)) : 0.5`
//! (`ledgerRepository.ts:89-91`): an absent value is `NaN` and selects `0.5`, a
//! present finite value is clamped into `[0, 1]`, and `NaN`/`±Infinity` fall
//! back. [`LedgerRepository::upsert_meeting_ledger`] reproduces that table.

use rusqlite::params_from_iter;
use rusqlite::types::Value;
use rusqlite::{params, Connection, OptionalExtension};

use super::{
    as_limit, now_iso, parse_iso, parse_json_array, to_source_refs, to_string_array, trimmed_or,
    KnowledgeRepositoryError,
};
use crate::knowledge::repository::{
    ListKnowledgeFilter, MeetingLedgerEntry, UpsertMeetingLedgerInput,
};

/// `LedgerRepository` from `ledgerRepository.ts:10`.
pub struct LedgerRepository<'a> {
    db: &'a Connection,
}

impl<'a> LedgerRepository<'a> {
    pub fn new(db: &'a Connection) -> Self {
        Self { db }
    }

    /// `upsertMeetingLedger` from `ledgerRepository.ts:13-100`.
    pub fn upsert_meeting_ledger(
        &self,
        input: &UpsertMeetingLedgerInput,
    ) -> Result<MeetingLedgerEntry, KnowledgeRepositoryError> {
        let now = now_iso();
        let event_at = parse_iso(input.event_at.as_deref());
        let topic_key = trimmed_or(&input.topic_key, "general");

        let existing_id = self
            .db
            .query_row(
                "
                SELECT id
                FROM knowledge_meeting_ledger
                WHERE conversation_id = ?
                  AND persona_id = ?
                  AND topic_key = ?
                  AND COALESCE(event_at, '') = COALESCE(?, '')
                LIMIT 1
              ",
                params![input.conversation_id, input.persona_id, topic_key, event_at],
                |row| row.get::<_, String>(0),
            )
            .optional()?;

        let id = existing_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

        let counterpart = input
            .counterpart
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let participants_json = serde_json::to_string(&to_string_array(&input.participants))?;
        let decisions_json = serde_json::to_string(&to_string_array(&input.decisions))?;
        let negotiated_terms_json =
            serde_json::to_string(&to_string_array(&input.negotiated_terms))?;
        let open_points_json = serde_json::to_string(&to_string_array(&input.open_points))?;
        let action_items_json = serde_json::to_string(&to_string_array(&input.action_items))?;
        let source_refs_json = serde_json::to_string(&to_source_refs(&input.source_refs))?;
        let memory_ids_json = serde_json::to_string(&input.memory_ids)?;
        let confidence = match input.confidence {
            Some(value) if value.is_finite() => value.clamp(0.0, 1.0),
            _ => 0.5,
        };

        self.db.execute(
            "
            INSERT INTO knowledge_meeting_ledger (
              id,
              user_id,
              persona_id,
              conversation_id,
              topic_key,
              counterpart,
              event_at,
              participants_json,
              decisions_json,
              negotiated_terms_json,
              open_points_json,
              action_items_json,
              source_refs_json,
              memory_ids_json,
              confidence,
              created_at,
              updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(conversation_id, persona_id, topic_key, event_at)
            DO UPDATE SET
              counterpart = excluded.counterpart,
              participants_json = excluded.participants_json,
              decisions_json = excluded.decisions_json,
              negotiated_terms_json = excluded.negotiated_terms_json,
              open_points_json = excluded.open_points_json,
              action_items_json = excluded.action_items_json,
              source_refs_json = excluded.source_refs_json,
              memory_ids_json = excluded.memory_ids_json,
              confidence = excluded.confidence,
              updated_at = excluded.updated_at
          ",
            params![
                id,
                input.user_id,
                input.persona_id,
                input.conversation_id,
                topic_key,
                counterpart,
                event_at,
                participants_json,
                decisions_json,
                negotiated_terms_json,
                open_points_json,
                action_items_json,
                source_refs_json,
                memory_ids_json,
                confidence,
                now,
                now
            ],
        )?;

        let row = self
            .db
            .query_row(
                "SELECT * FROM knowledge_meeting_ledger WHERE id = ?",
                params![id],
                read_ledger_row,
            )
            .optional()?
            .ok_or_else(|| KnowledgeRepositoryError::MissingRow {
                context: "knowledge_meeting_ledger".to_string(),
            })?;
        Ok(self.map_ledger(row))
    }

    /// `listMeetingLedger` from `ledgerRepository.ts:102-139`.
    pub fn list_meeting_ledger(
        &self,
        filter: &ListKnowledgeFilter,
    ) -> Result<Vec<MeetingLedgerEntry>, KnowledgeRepositoryError> {
        let limit = as_limit(filter.limit, 20);
        let mut conditions = vec!["user_id = ?".to_string(), "persona_id = ?".to_string()];
        let mut values = vec![
            Value::Text(filter.user_id.clone()),
            Value::Text(filter.persona_id.clone()),
        ];

        if let Some(counterpart) = filter
            .counterpart
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            conditions.push("LOWER(COALESCE(counterpart, '')) LIKE ?".to_string());
            values.push(Value::Text(format!("%{}%", counterpart.to_lowercase())));
        }
        if let Some(topic_key) = filter
            .topic_key
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            conditions.push("LOWER(topic_key) LIKE ?".to_string());
            values.push(Value::Text(format!("%{}%", topic_key.to_lowercase())));
        }
        if let Some(from_iso) = parse_iso(filter.from.as_deref()) {
            conditions.push("(event_at IS NULL OR event_at >= ?)".to_string());
            values.push(Value::Text(from_iso));
        }
        if let Some(to_iso) = parse_iso(filter.to.as_deref()) {
            conditions.push("(event_at IS NULL OR event_at <= ?)".to_string());
            values.push(Value::Text(to_iso));
        }
        values.push(Value::Integer(limit));

        let sql = format!(
            "
            SELECT *
            FROM knowledge_meeting_ledger
            WHERE {}
            ORDER BY COALESCE(event_at, updated_at) DESC
            LIMIT ?
          ",
            conditions.join(" AND ")
        );
        let mut statement = self.db.prepare(&sql)?;
        let rows = statement.query_map(params_from_iter(values), read_ledger_row)?;
        let mut entries = Vec::new();
        for row in rows {
            entries.push(self.map_ledger(row?));
        }
        Ok(entries)
    }

    /// `mapLedger` from `ledgerRepository.ts:141-160`.
    fn map_ledger(&self, row: LedgerRow) -> MeetingLedgerEntry {
        MeetingLedgerEntry {
            id: row.id,
            user_id: row.user_id,
            persona_id: row.persona_id,
            conversation_id: row.conversation_id,
            topic_key: row.topic_key,
            counterpart: row
                .counterpart
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty()),
            event_at: parse_iso(row.event_at.as_deref()),
            participants: parse_json_array(row.participants_json.as_deref()),
            decisions: parse_json_array(row.decisions_json.as_deref()),
            negotiated_terms: parse_json_array(row.negotiated_terms_json.as_deref()),
            open_points: parse_json_array(row.open_points_json.as_deref()),
            action_items: parse_json_array(row.action_items_json.as_deref()),
            source_refs: parse_json_array(row.source_refs_json.as_deref()),
            memory_ids: parse_json_array(row.memory_ids_json.as_deref()),
            confidence: row.confidence.unwrap_or(0.0),
            updated_at: row.updated_at.unwrap_or_default(),
        }
    }
}

/// The columns of a `knowledge_meeting_ledger` row, before `mapLedger` coerces
/// them exactly like the TypeScript reader.
struct LedgerRow {
    id: String,
    user_id: String,
    persona_id: String,
    conversation_id: String,
    topic_key: String,
    counterpart: Option<String>,
    event_at: Option<String>,
    participants_json: Option<String>,
    decisions_json: Option<String>,
    negotiated_terms_json: Option<String>,
    open_points_json: Option<String>,
    action_items_json: Option<String>,
    source_refs_json: Option<String>,
    confidence: Option<f64>,
    updated_at: Option<String>,
    memory_ids_json: Option<String>,
}

/// Reads the `SELECT *` projection by position; `memory_ids_json` was appended by
/// the additive `ALTER TABLE` and is the last column.
fn read_ledger_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<LedgerRow> {
    Ok(LedgerRow {
        id: row.get(0)?,
        user_id: row.get(1)?,
        persona_id: row.get(2)?,
        conversation_id: row.get(3)?,
        topic_key: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
        counterpart: row.get(5)?,
        event_at: row.get(6)?,
        participants_json: row.get(7)?,
        decisions_json: row.get(8)?,
        negotiated_terms_json: row.get(9)?,
        open_points_json: row.get(10)?,
        action_items_json: row.get(11)?,
        source_refs_json: row.get(12)?,
        confidence: row.get(13)?,
        updated_at: row.get(15)?,
        memory_ids_json: row.get(16)?,
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

    fn input(confidence: Option<f64>, event_at: Option<&str>) -> UpsertMeetingLedgerInput {
        UpsertMeetingLedgerInput {
            user_id: "u-1".to_string(),
            persona_id: "p-1".to_string(),
            conversation_id: "c-1".to_string(),
            topic_key: "   ".to_string(),
            counterpart: Some("  Max  ".to_string()),
            event_at: event_at.map(str::to_string),
            participants: vec!["  Max ".to_string(), String::new()],
            decisions: vec!["ship it".to_string()],
            negotiated_terms: vec![],
            open_points: vec![],
            action_items: vec!["follow up".to_string()],
            source_refs: vec![],
            memory_ids: vec!["m-1".to_string()],
            confidence,
        }
    }

    #[test]
    fn confidence_follows_the_typescript_table() {
        let connection = connection();
        let repo = LedgerRepository::new(&connection);

        let absent = repo
            .upsert_meeting_ledger(&input(None, None))
            .expect("upsert");
        assert_eq!(absent.confidence, 0.5, "an absent value is NaN");
        assert_eq!(absent.topic_key, "general");
        assert_eq!(absent.counterpart.as_deref(), Some("Max"));
        assert_eq!(absent.participants, vec!["Max"]);

        let high = repo
            .upsert_meeting_ledger(&input(Some(1.5), Some("2026-01-01T00:00:00Z")))
            .expect("upsert");
        assert_eq!(high.confidence, 1.0);

        let low = repo
            .upsert_meeting_ledger(&input(Some(-1.0), Some("2026-02-01T00:00:00Z")))
            .expect("upsert");
        assert_eq!(low.confidence, 0.0);

        let in_range = repo
            .upsert_meeting_ledger(&input(Some(0.9), Some("2026-03-01T00:00:00Z")))
            .expect("upsert");
        assert_eq!(in_range.confidence, 0.9);
    }

    /// `COALESCE(event_at, '') = COALESCE(?, '')` matches a `NULL` event to a
    /// `NULL` event: the second write re-uses the first row's id instead of
    /// minting a new one.
    ///
    /// The TypeScript then fails, and the port keeps that failure because the
    /// statement is verbatim (contract 2): with a `NULL` in
    /// `ON CONFLICT(conversation_id, persona_id, topic_key, event_at)` the
    /// `UNIQUE` index never matches (SQLite treats two `NULL`s as distinct), so
    /// the reused id collides with the primary key and SQLite raises
    /// `UNIQUE constraint failed: knowledge_meeting_ledger.id`. The only way
    /// that error can be produced is through the `COALESCE` lookup below.
    #[test]
    fn a_null_event_at_matches_a_null_event_at() {
        let connection = connection();
        let repo = LedgerRepository::new(&connection);

        let first = repo
            .upsert_meeting_ledger(&input(None, None))
            .expect("first");
        let error = repo
            .upsert_meeting_ledger(&input(Some(0.7), None))
            .expect_err("the reused id collides with the stored row");
        assert!(
            error
                .to_string()
                .contains("UNIQUE constraint failed: knowledge_meeting_ledger.id"),
            "unexpected error: {error}"
        );

        // A freshly generated id would not collide; the row count and the stored
        // id therefore prove that the lookup matched `NULL` to `NULL`.
        let rows: i64 = connection
            .query_row("SELECT COUNT(*) FROM knowledge_meeting_ledger", [], |row| {
                row.get(0)
            })
            .expect("count");
        assert_eq!(rows, 1);
        let stored: String = connection
            .query_row("SELECT id FROM knowledge_meeting_ledger", [], |row| {
                row.get(0)
            })
            .expect("id");
        assert_eq!(stored, first.id);

        // The same non-`NULL` event does reach the `DO UPDATE` branch.
        let dated = repo
            .upsert_meeting_ledger(&input(None, Some("2026-01-01T00:00:00Z")))
            .expect("dated");
        let updated = repo
            .upsert_meeting_ledger(&input(Some(0.9), Some("2026-01-01T00:00:00Z")))
            .expect("update");
        assert_eq!(dated.id, updated.id);
        assert_eq!(updated.confidence, 0.9);
        let rows: i64 = connection
            .query_row("SELECT COUNT(*) FROM knowledge_meeting_ledger", [], |row| {
                row.get(0)
            })
            .expect("count");
        assert_eq!(rows, 2);
    }

    #[test]
    fn list_is_newest_first_and_respects_the_window() {
        let connection = connection();
        let repo = LedgerRepository::new(&connection);
        repo.upsert_meeting_ledger(&input(None, Some("2026-01-05T00:00:00Z")))
            .expect("one");
        repo.upsert_meeting_ledger(&input(None, Some("2026-03-05T00:00:00Z")))
            .expect("three");

        let all = repo
            .list_meeting_ledger(&ListKnowledgeFilter {
                user_id: "u-1".to_string(),
                persona_id: "p-1".to_string(),
                ..Default::default()
            })
            .expect("list");
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].event_at.as_deref(), Some("2026-03-05T00:00:00.000Z"));

        let windowed = repo
            .list_meeting_ledger(&ListKnowledgeFilter {
                user_id: "u-1".to_string(),
                persona_id: "p-1".to_string(),
                from: Some("2026-02-01T00:00:00Z".to_string()),
                ..Default::default()
            })
            .expect("list");
        assert_eq!(windowed.len(), 1);
    }
}
