//! Port of `src/server/knowledge/repositories/auditRepository.ts`.
//!
//! | TypeScript member                                  | Rust member |
//! | -------------------------------------------------- | ----------- |
//! | `auditRepository.ts:6` (class)                      | [`AuditRepository`] |
//! | `auditRepository.ts:9-47` (`insertRetrievalAudit`)  | [`AuditRepository::insert_retrieval_audit`] |
//! | `auditRepository.ts:49-68` (`listRetrievalAudit`)   | [`AuditRepository::list_retrieval_audit`] |
//! | `auditRepository.ts:70-92` (`mapAudit`)             | [`AuditRepository::map_audit`] |
//!
//! # JavaScript semantics that are reproduced explicitly
//!
//! * The id is `crypto.randomUUID()` ([`uuid::Uuid::new_v4`]).
//! * `String(input.query || '').trim()`, `Math.max(0, Math.floor(Number(input.tokenCount || 0)))`
//!   and `input.hadError ? 1 : 0` are applied in the same order.
//! * `mapAudit` keeps a stage stat only when `Number(value)` is finite:
//!   `{"ok": 3, "slow": "nope"}` becomes `{"ok": 3}`. [`js_number_value`]
//!   reproduces `Number(value)` for a JSON scalar.
//! * `hadError: Number(row.had_error || 0) === 1` — only the integer `1` is
//!   `true`; `2` is `false`.
//!
//! # Deviation
//!
//! `stage_stats_json` is written from a [`BTreeMap`], so the object keys come out
//! in sorted order while the TypeScript keeps insertion order. No consumer reads
//! the order; the values and the JSON shape are identical.

use std::collections::BTreeMap;

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;

use super::{as_limit, parse_json_object, KnowledgeRepositoryError};
use crate::knowledge::repository::{
    InsertRetrievalAuditInput, ListRetrievalAuditFilter, RetrievalAuditEntry,
};

/// `AuditRepository` from `auditRepository.ts:6`.
pub struct AuditRepository<'a> {
    db: &'a Connection,
}

/// `Number(value)` for a JSON scalar, used by `mapAudit` (`auditRepository.ts:74`).
///
/// `Number(3)` is 3, `Number('3')` is 3, `Number('nope')` is `NaN`. The
/// TypeScript only reaches this with the values `JSON.parse` produced, i.e.
/// scalars; `Number([])`/`Number({})` are not reproduced because `parseJsonObject`
/// already rejects a non-object top level and never descends into an array value.
fn js_number_value(value: &Value) -> f64 {
    match value {
        Value::Number(number) => number.as_f64().unwrap_or(f64::NAN),
        Value::String(text) => crate::js::js_number_str(text),
        Value::Bool(true) => 1.0,
        Value::Bool(false) => 0.0,
        Value::Null => 0.0,
        Value::Array(_) | Value::Object(_) => f64::NAN,
    }
}

impl<'a> AuditRepository<'a> {
    pub fn new(db: &'a Connection) -> Self {
        Self { db }
    }

    /// `insertRetrievalAudit` from `auditRepository.ts:9-47`.
    pub fn insert_retrieval_audit(
        &self,
        input: &InsertRetrievalAuditInput,
    ) -> Result<RetrievalAuditEntry, KnowledgeRepositoryError> {
        let id = uuid::Uuid::new_v4().to_string();
        let now = super::now_iso();

        let stage_stats_json = serde_json::to_string(&input.stage_stats)?;
        let token_count = input.token_count.max(0);
        let had_error = if input.had_error { 1 } else { 0 };
        let error_message = input
            .error_message
            .as_deref()
            .filter(|value| !value.is_empty())
            .map(|value| value.trim().to_string());

        self.db.execute(
            "
            INSERT INTO knowledge_retrieval_audit (
              id,
              user_id,
              persona_id,
              conversation_id,
              query_text,
              stage_stats_json,
              token_count,
              had_error,
              error_message,
              created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ",
            params![
                id,
                input.user_id,
                input.persona_id,
                input.conversation_id,
                input.query.trim(),
                stage_stats_json,
                token_count,
                had_error,
                error_message,
                now
            ],
        )?;

        let row = self
            .db
            .query_row(
                "SELECT * FROM knowledge_retrieval_audit WHERE id = ? LIMIT 1",
                params![id],
                read_audit_row,
            )
            .optional()?
            .ok_or_else(|| KnowledgeRepositoryError::MissingRow {
                context: "knowledge_retrieval_audit".to_string(),
            })?;
        Ok(self.map_audit(row))
    }

    /// `listRetrievalAudit` from `auditRepository.ts:49-68`.
    pub fn list_retrieval_audit(
        &self,
        filter: &ListRetrievalAuditFilter,
    ) -> Result<Vec<RetrievalAuditEntry>, KnowledgeRepositoryError> {
        let limit = as_limit(filter.limit, 25);
        let mut statement = self.db.prepare(
            "
            SELECT *
            FROM knowledge_retrieval_audit
            WHERE user_id = ? AND persona_id = ?
            ORDER BY created_at DESC
            LIMIT ?
          ",
        )?;
        let rows = statement.query_map(
            params![filter.user_id, filter.persona_id, limit],
            read_audit_row,
        )?;
        let mut entries = Vec::new();
        for row in rows {
            entries.push(self.map_audit(row?));
        }
        Ok(entries)
    }

    /// `mapAudit` from `auditRepository.ts:70-92`.
    fn map_audit(&self, row: AuditRow) -> RetrievalAuditEntry {
        let mut stage_stats: BTreeMap<String, f64> = BTreeMap::new();
        for (key, value) in parse_json_object(Some(&row.stage_stats_json)) {
            let numeric = js_number_value(&value);
            if numeric.is_finite() {
                stage_stats.insert(key, numeric);
            }
        }

        RetrievalAuditEntry {
            id: row.id,
            user_id: row.user_id,
            persona_id: row.persona_id,
            conversation_id: row.conversation_id,
            query: row.query_text,
            stage_stats,
            token_count: row.token_count.unwrap_or(0),
            had_error: row.had_error.unwrap_or(0) == 1,
            error_message: row
                .error_message
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty()),
            created_at: row.created_at.unwrap_or_default(),
        }
    }
}

/// The columns of a `knowledge_retrieval_audit` row, before `mapAudit` coerces
/// them exactly like the TypeScript reader.
struct AuditRow {
    id: String,
    user_id: String,
    persona_id: String,
    conversation_id: String,
    query_text: String,
    stage_stats_json: String,
    token_count: Option<i64>,
    had_error: Option<i64>,
    error_message: Option<String>,
    created_at: Option<String>,
}

/// Reads the `SELECT *` projection by position, matching the table column order
/// declared in [`super::migrations`].
fn read_audit_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AuditRow> {
    Ok(AuditRow {
        id: row.get(0)?,
        user_id: row.get(1)?,
        persona_id: row.get(2)?,
        conversation_id: row.get(3)?,
        query_text: row.get(4)?,
        stage_stats_json: row.get(5)?,
        token_count: row.get(6)?,
        had_error: row.get(7)?,
        error_message: row.get(8)?,
        created_at: row.get(9)?,
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

    fn input(had_error: bool) -> InsertRetrievalAuditInput {
        let mut stage_stats = BTreeMap::new();
        stage_stats.insert("candidate".to_string(), 4.0);
        stage_stats.insert("expanded".to_string(), 2.0);
        InsertRetrievalAuditInput {
            user_id: "u-1".to_string(),
            persona_id: "p-1".to_string(),
            conversation_id: "c-1".to_string(),
            query: "  was ist neu?  ".to_string(),
            stage_stats,
            token_count: 128,
            had_error,
            error_message: None,
        }
    }

    #[test]
    fn an_insert_round_trips_through_star() {
        let connection = connection();
        let repo = AuditRepository::new(&connection);

        let entry = repo.insert_retrieval_audit(&input(false)).expect("insert");
        assert_eq!(entry.query, "was ist neu?");
        assert_eq!(entry.token_count, 128);
        assert!(!entry.had_error);
        assert_eq!(entry.stage_stats.get("candidate"), Some(&4.0));
        assert!(entry.error_message.is_none());
        assert!(!entry.created_at.is_empty());
    }

    #[test]
    fn had_error_is_only_true_for_the_integer_one() {
        let connection = connection();
        let repo = AuditRepository::new(&connection);

        let entry = repo
            .insert_retrieval_audit(&InsertRetrievalAuditInput {
                error_message: Some("  boom  ".to_string()),
                ..input(true)
            })
            .expect("insert");
        assert!(entry.had_error);
        assert_eq!(entry.error_message.as_deref(), Some("boom"));
    }

    #[test]
    fn map_audit_keeps_only_finite_stage_stats() {
        let connection = connection();
        let repo = AuditRepository::new(&connection);
        connection
            .execute_batch(
                r#"
                INSERT INTO knowledge_retrieval_audit
                  (id, user_id, persona_id, conversation_id, query_text, stage_stats_json,
                   token_count, had_error, error_message, created_at)
                VALUES ('a-1', 'u-1', 'p-1', 'c-1', 'q',
                        '{"ok":3,"slow":"nope","flag":true,"nil":null}', 0, 2, '', 't0');
                "#,
            )
            .expect("seed");

        let entry = repo
            .list_retrieval_audit(&ListRetrievalAuditFilter {
                user_id: "u-1".to_string(),
                persona_id: "p-1".to_string(),
                limit: None,
            })
            .expect("list")
            .into_iter()
            .next()
            .expect("one row");

        assert_eq!(
            entry.stage_stats.len(),
            3,
            "the non-numeric string is dropped"
        );
        assert_eq!(entry.stage_stats.get("ok"), Some(&3.0));
        assert_eq!(entry.stage_stats.get("flag"), Some(&1.0));
        assert_eq!(entry.stage_stats.get("nil"), Some(&0.0));
        assert!(!entry.had_error, "2 is not the integer 1");
        assert!(entry.error_message.is_none(), "'' trims to null");
    }

    #[test]
    fn list_is_newest_first_and_respects_the_limit() {
        let connection = connection();
        let repo = AuditRepository::new(&connection);
        connection
            .execute_batch(
                r#"
                INSERT INTO knowledge_retrieval_audit VALUES
                  ('a-1','u-1','p-1','c-1','first','{}',0,0,NULL,'2026-01-01T00:00:00.000Z'),
                  ('a-2','u-1','p-1','c-1','second','{}',0,0,NULL,'2026-02-01T00:00:00.000Z'),
                  ('a-3','u-2','p-1','c-1','other','{}',0,0,NULL,'2026-03-01T00:00:00.000Z');
                "#,
            )
            .expect("seed");

        let entries = repo
            .list_retrieval_audit(&ListRetrievalAuditFilter {
                user_id: "u-1".to_string(),
                persona_id: "p-1".to_string(),
                limit: Some(1),
            })
            .expect("list");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].query, "second");
    }
}
