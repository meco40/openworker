//! Port of `src/server/world-model/retrieval/openLoops.ts` (55 lines).
//!
//! | TypeScript | Rust |
//! | --- | --- |
//! | `openLoops.ts:4-11` (`OpenLoopRetrievalHit`) | [`OpenLoopRetrievalHit`] |
//! | `openLoops.ts:13-56` (`searchOpenLoops`) | [`search_open_loops`] |
//! | `openLoops.ts:44-46` (statement) | [`statement_sql`] |
//!
//! # Verified TypeScript quirks
//!
//! * The query condition uses the **hard-coded** placeholder `$4`
//!   (`openLoops.ts:31`) instead of a computed index; the limit placeholder is
//!   then `$<params.length>`, which is `$4` without a query and `$5` with one.
//! * `options.query?.trim()` is the truthiness test (`:30`), so a
//!   whitespace-only query is skipped *and* the pushed pattern uses the trimmed
//!   text (`:32`) — the only retrieval statement that trims its pattern.
//! * `attempts` goes through `Number(row.attempts)` (`:54`) while `question`
//!   stays `string | null`.
//! * `limit` is clamped (`Math.min(50, Math.max(1, …))`, `:22`) and this module
//!   calls `getWorldModelDb()` inline instead of an earlier local (`:36`).
//!
//! The statement is one scoped transaction and the scope is a parameter
//! (`.tmp/s6s7-plan.md`, rule 7); the `enabled`/`e2eEnabled` gate of `:20-21`
//! runs before it and a failing statement propagates.

use crate::world_model::config::WorldModelConfig;
use crate::world_model::db::{
    scoped_query, NormalizedScope, PgError, PgExecutor, PgStatement, PgValue,
};

use super::{clamp_limit, row_number, row_optional_string, row_string};

/// `OpenLoopRetrievalHit` from `openLoops.ts:4-11`.
#[derive(Debug, Clone, PartialEq)]
pub struct OpenLoopRetrievalHit {
    pub id: String,
    /// `type` in the source — the `OpenLoopType` union, read as text because the
    /// hit shape declares `string`.
    pub loop_type: String,
    pub status: String,
    pub question: Option<String>,
    pub attempts: f64,
    pub last_asked_at: Option<String>,
}

/// The options of `searchOpenLoops` — `openLoops.ts:13-19`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct OpenLoopRetrievalOptions {
    pub query: Option<String>,
    pub limit: Option<i64>,
}

/// The `WHERE` clause, the `LIMIT` placeholder and the parameters of
/// `openLoops.ts:23-35`.
fn build(
    scope: &NormalizedScope,
    options: &OpenLoopRetrievalOptions,
) -> (String, String, Vec<PgValue>) {
    let mut conditions = vec![
        "user_id = $1".to_string(),
        "persona_id = $2".to_string(),
        "workspace_id = $3".to_string(),
        "status IN ('open','scheduled','asked')".to_string(),
    ];
    let mut params = vec![
        PgValue::text(scope.user_id.as_str()),
        PgValue::text(scope.persona_id.as_str()),
        PgValue::text(scope.workspace_id.as_str()),
    ];

    let trimmed_query = options
        .query
        .as_deref()
        .map(str::trim)
        .filter(|text| !text.is_empty());
    if let Some(query) = trimmed_query {
        conditions.push("LOWER(COALESCE(question, '')) LIKE $4".to_string());
        params.push(PgValue::text(format!("%{}%", query.to_lowercase())));
    }

    params.push(PgValue::int(clamp_limit(options.limit.unwrap_or(10))));
    let limit_param = format!("${}", params.len());
    (conditions.join(" AND "), limit_param, params)
}

/// The statement of `openLoops.ts:44-46`, token for token.
fn statement_sql(conditions: &str, limit_param: &str) -> String {
    format!("SELECT id, type, status, question, attempts, last_asked_at\n     FROM world_model_open_loops WHERE {conditions}\n     ORDER BY COALESCE(last_asked_at, created_at) DESC LIMIT {limit_param}")
}

/// `searchOpenLoops(options)` — `openLoops.ts:13-56`.
pub async fn search_open_loops(
    executor: &dyn PgExecutor,
    config: &WorldModelConfig,
    scope: &NormalizedScope,
    options: &OpenLoopRetrievalOptions,
) -> Result<Vec<OpenLoopRetrievalHit>, PgError> {
    if !config.enabled && !config.e2e_enabled {
        return Ok(Vec::new());
    }

    let (conditions, limit_param, params) = build(scope, options);
    let statement = PgStatement::with_params(statement_sql(&conditions, &limit_param), params);
    let result = scoped_query::<PgError>(executor, scope, statement).await?;

    Ok(result
        .rows
        .iter()
        .map(|row| OpenLoopRetrievalHit {
            id: row_string(row, "id"),
            loop_type: row_string(row, "type"),
            status: row_string(row, "status"),
            question: row_optional_string(row, "question"),
            attempts: row_number(row, "attempts"),
            last_asked_at: row_optional_string(row, "last_asked_at"),
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world_model::db::testing::{Recorded, RecordingExecutor};
    use crate::world_model::db::{drive_sync, PgQueryResult, PgRow};
    use serde_json::json;

    use super::super::{test_config, test_scope};

    fn statement_of(executor: &RecordingExecutor) -> PgStatement {
        executor
            .calls()
            .into_iter()
            .find_map(|call| match call {
                Recorded::Statement(statement)
                    if !statement.params.is_empty()
                        && statement.sql != crate::world_model::db::SQL_SET_SCOPE =>
                {
                    Some(statement)
                }
                _ => None,
            })
            .expect("one parameterised statement")
    }

    fn search_with(
        options: &OpenLoopRetrievalOptions,
        rows: Vec<PgRow>,
    ) -> (Vec<OpenLoopRetrievalHit>, PgStatement) {
        let executor = RecordingExecutor::new(vec![Ok(PgQueryResult::from_rows(rows))]);
        let hits = drive_sync(search_open_loops(
            &executor,
            &test_config(true, false),
            &test_scope(),
            options,
        ))
        .expect("bridge")
        .expect("scoped query");
        (hits, statement_of(&executor))
    }

    fn row() -> PgRow {
        json!({
            "id": "loop-1",
            "type": "clarification",
            "status": "open",
            "question": null,
            "attempts": "1",
            "last_asked_at": null,
        })
        .as_object()
        .unwrap()
        .clone()
    }

    #[test]
    fn a_disabled_config_answers_empty_without_a_statement() {
        let executor = RecordingExecutor::new(Vec::new());
        let hits = drive_sync(search_open_loops(
            &executor,
            &test_config(false, false),
            &test_scope(),
            &OpenLoopRetrievalOptions::default(),
        ))
        .expect("bridge")
        .expect("gate");
        assert!(hits.is_empty());
        assert!(executor.calls().is_empty());
    }

    #[test]
    fn the_statement_without_a_query_uses_the_fourth_placeholder_for_the_limit() {
        let (_, statement) = search_with(&OpenLoopRetrievalOptions::default(), Vec::new());
        assert_eq!(
            statement.sql,
            "SELECT id, type, status, question, attempts, last_asked_at\n     FROM world_model_open_loops WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3 AND status IN ('open','scheduled','asked')\n     ORDER BY COALESCE(last_asked_at, created_at) DESC LIMIT $4"
        );
        assert_eq!(
            statement.params,
            vec![
                PgValue::text("u1"),
                PgValue::text("p1"),
                PgValue::text("w1"),
                PgValue::int(10),
            ]
        );
    }

    /// The hard-coded `$4` of `openLoops.ts:31` pushes the limit to `$5`, and
    /// the pattern is built from the **trimmed** query (`:32`).
    #[test]
    fn a_query_uses_the_hard_coded_placeholder_and_a_trimmed_pattern() {
        let (_, statement) = search_with(
            &OpenLoopRetrievalOptions {
                query: Some("  Film  ".to_string()),
                limit: Some(3),
            },
            Vec::new(),
        );
        assert!(
            statement
                .sql
                .contains("AND LOWER(COALESCE(question, '')) LIKE $4\n     ORDER BY"),
            "{}",
            statement.sql
        );
        assert!(statement.sql.ends_with("LIMIT $5"), "{}", statement.sql);
        assert_eq!(
            statement.params,
            vec![
                PgValue::text("u1"),
                PgValue::text("p1"),
                PgValue::text("w1"),
                PgValue::text("%film%"),
                PgValue::int(3),
            ]
        );
    }

    /// `options.query?.trim()` is truthiness, so whitespace alone is skipped.
    #[test]
    fn a_whitespace_only_query_is_skipped() {
        let (_, statement) = search_with(
            &OpenLoopRetrievalOptions {
                query: Some("   ".to_string()),
                limit: None,
            },
            Vec::new(),
        );
        assert!(statement.sql.ends_with("LIMIT $4"));
        assert_eq!(statement.params.len(), 4);
    }

    #[test]
    fn rows_map_attempts_through_number() {
        let (hits, _) = search_with(&OpenLoopRetrievalOptions::default(), vec![row()]);
        assert_eq!(
            hits,
            vec![OpenLoopRetrievalHit {
                id: "loop-1".to_string(),
                loop_type: "clarification".to_string(),
                status: "open".to_string(),
                question: None,
                attempts: 1.0,
                last_asked_at: None,
            }]
        );
    }

    #[test]
    fn a_failing_statement_propagates() {
        let executor = RecordingExecutor::new(vec![Err(PgError::new("boom"))]);
        let error = drive_sync(search_open_loops(
            &executor,
            &test_config(true, false),
            &test_scope(),
            &OpenLoopRetrievalOptions::default(),
        ))
        .expect("bridge")
        .expect_err("the statement fails");
        assert_eq!(error, PgError::new("boom"));
    }
}
