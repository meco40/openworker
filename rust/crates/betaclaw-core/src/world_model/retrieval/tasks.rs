//! Port of `src/server/world-model/retrieval/tasks.ts` (71 lines).
//!
//! | TypeScript | Rust |
//! | --- | --- |
//! | `tasks.ts:9-15` (`TaskRetrievalHit`) | [`TaskRetrievalHit`] |
//! | `tasks.ts:17-26` (`TaskRetrievalOptions`) | [`TaskRetrievalOptions`] |
//! | `tasks.ts:28-80` (`searchTasks`) | [`search_tasks`] |
//! | `tasks.ts:65-69` (statement) | [`statement_sql`] |
//!
//! # Verified TypeScript quirks
//!
//! * `options.overdue` is a truthiness test of a `boolean | undefined`, so
//!   `overdue: false` and an absent flag are the same (`:45`); the predicate is
//!   a literal that binds **no** parameter — `now()` is the database clock.
//! * The status default is a literal `IN` list (`:42`) while an explicit status
//!   binds one parameter (`:39`), so the parameter indices of the following
//!   options depend on whether `status` was given.
//! * `options.query` is lower-cased into `%…%` (`:50`) and `options.knownAsOf`
//!   bounds `created_at`, not `updated_at` (`:53`).
//! * `limit` is clamped (`Math.min(50, Math.max(1, …))`, `:33`).
//! * `due_at` stays nullable in the hit (`:77`) — `null` is *not* folded into
//!   `undefined` here, unlike `structured.ts:117`.
//!
//! The statement is one scoped transaction and the scope is a parameter
//! (`.tmp/s6s7-plan.md`, rule 7); the `enabled`/`e2eEnabled` gate of `:29-30`
//! runs before it and a failing statement propagates.

use crate::world_model::config::WorldModelConfig;
use crate::world_model::db::{
    scoped_query, NormalizedScope, PgError, PgExecutor, PgStatement, PgValue,
};

use super::{clamp_limit, row_optional_string, row_string};

/// `TaskRetrievalHit` from `tasks.ts:9-15`.
#[derive(Debug, Clone, PartialEq)]
pub struct TaskRetrievalHit {
    pub id: String,
    pub title: String,
    pub status: String,
    /// `string | null` in the source type.
    pub due_at: Option<String>,
    pub created_at: String,
}

/// `TaskRetrievalOptions` from `tasks.ts:17-26`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TaskRetrievalOptions {
    pub status: Option<String>,
    pub overdue: bool,
    pub limit: Option<i64>,
    pub query: Option<String>,
    pub known_as_of: Option<String>,
}

/// The truthiness of an optional string — `if (options.x)`.
fn present(value: Option<&str>) -> Option<&str> {
    value.filter(|text| !text.is_empty())
}

/// The `WHERE` clause, the `LIMIT` placeholder and the parameters of
/// `tasks.ts:34-57`.
fn build(
    scope: &NormalizedScope,
    options: &TaskRetrievalOptions,
) -> (String, String, Vec<PgValue>) {
    let mut conditions = vec![
        "t.user_id = $1".to_string(),
        "t.persona_id = $2".to_string(),
        "t.workspace_id = $3".to_string(),
    ];
    let mut params = vec![
        PgValue::text(scope.user_id.as_str()),
        PgValue::text(scope.persona_id.as_str()),
        PgValue::text(scope.workspace_id.as_str()),
    ];
    let mut index = 4;

    if let Some(status) = present(options.status.as_deref()) {
        conditions.push(format!("t.status = ${index}"));
        params.push(PgValue::text(status));
        index += 1;
    } else {
        conditions
            .push("t.status IN ('proposed', 'planned', 'in_progress', 'waiting')".to_string());
    }

    if options.overdue {
        conditions.push("t.due_at IS NOT NULL AND t.due_at < now()".to_string());
    }

    if let Some(query) = present(options.query.as_deref()) {
        conditions.push(format!("LOWER(t.title) LIKE ${index}"));
        params.push(PgValue::text(format!("%{}%", query.to_lowercase())));
        index += 1;
    }

    if let Some(known_as_of) = present(options.known_as_of.as_deref()) {
        conditions.push(format!("t.created_at <= ${index}"));
        params.push(PgValue::text(known_as_of));
        index += 1;
    }

    params.push(PgValue::int(clamp_limit(options.limit.unwrap_or(10))));
    (conditions.join(" AND "), format!("${index}"), params)
}

/// The statement of `tasks.ts:65-69`, token for token.
fn statement_sql(conditions: &str, limit_param: &str) -> String {
    format!("SELECT t.id, t.title, t.status, t.due_at, t.created_at\n     FROM world_model_tasks t\n     WHERE {conditions}\n     ORDER BY COALESCE(t.due_at, t.created_at) ASC\n     LIMIT {limit_param}")
}

/// `searchTasks(options)` — `tasks.ts:28-80`.
pub async fn search_tasks(
    executor: &dyn PgExecutor,
    config: &WorldModelConfig,
    scope: &NormalizedScope,
    options: &TaskRetrievalOptions,
) -> Result<Vec<TaskRetrievalHit>, PgError> {
    if !config.enabled && !config.e2e_enabled {
        return Ok(Vec::new());
    }

    let (conditions, limit_param, params) = build(scope, options);
    let statement = PgStatement::with_params(statement_sql(&conditions, &limit_param), params);
    let result = scoped_query::<PgError>(executor, scope, statement).await?;

    Ok(result
        .rows
        .iter()
        .map(|row| TaskRetrievalHit {
            id: row_string(row, "id"),
            title: row_string(row, "title"),
            status: row_string(row, "status"),
            due_at: row_optional_string(row, "due_at"),
            created_at: row_string(row, "created_at"),
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
        options: &TaskRetrievalOptions,
        rows: Vec<PgRow>,
    ) -> (Vec<TaskRetrievalHit>, PgStatement) {
        let executor = RecordingExecutor::new(vec![Ok(PgQueryResult::from_rows(rows))]);
        let hits = drive_sync(search_tasks(
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
            "id": "t1",
            "title": "Tickets",
            "status": "planned",
            "due_at": null,
            "created_at": "2025-01-01T00:00:00.000Z",
        })
        .as_object()
        .unwrap()
        .clone()
    }

    #[test]
    fn a_disabled_config_answers_empty_without_a_statement() {
        let executor = RecordingExecutor::new(Vec::new());
        let hits = drive_sync(search_tasks(
            &executor,
            &test_config(false, false),
            &test_scope(),
            &TaskRetrievalOptions::default(),
        ))
        .expect("bridge")
        .expect("gate");
        assert!(hits.is_empty());
        assert!(executor.calls().is_empty());
    }

    /// The default branch of `tasks.ts:38-43`.
    #[test]
    fn the_default_statement_uses_the_status_in_list() {
        let (_, statement) = search_with(&TaskRetrievalOptions::default(), Vec::new());
        assert_eq!(
            statement.sql,
            "SELECT t.id, t.title, t.status, t.due_at, t.created_at\n     FROM world_model_tasks t\n     WHERE t.user_id = $1 AND t.persona_id = $2 AND t.workspace_id = $3 AND t.status IN ('proposed', 'planned', 'in_progress', 'waiting')\n     ORDER BY COALESCE(t.due_at, t.created_at) ASC\n     LIMIT $4"
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

    /// An explicit status spends a placeholder, the overdue predicate does not,
    /// and `query`/`knownAsOf` follow in source order.
    #[test]
    fn overdue_binds_no_parameter_and_query_lowercases() {
        let (_, statement) = search_with(
            &TaskRetrievalOptions {
                status: Some("planned".to_string()),
                overdue: true,
                query: Some("TICKETS".to_string()),
                known_as_of: Some("2024-01-01T00:00:00.000Z".to_string()),
                limit: Some(80),
            },
            Vec::new(),
        );
        assert!(
            statement.sql.contains(
                "AND t.status = $4 AND t.due_at IS NOT NULL AND t.due_at < now() AND LOWER(t.title) LIKE $5 AND t.created_at <= $6\n     ORDER BY"
            ),
            "{}",
            statement.sql
        );
        assert!(statement.sql.ends_with("LIMIT $7"), "{}", statement.sql);
        assert_eq!(
            statement.params,
            vec![
                PgValue::text("u1"),
                PgValue::text("p1"),
                PgValue::text("w1"),
                PgValue::text("planned"),
                PgValue::text("%tickets%"),
                PgValue::text("2024-01-01T00:00:00.000Z"),
                PgValue::int(50),
            ]
        );
    }

    #[test]
    fn overdue_false_and_empty_options_are_the_same() {
        let (_, statement) = search_with(
            &TaskRetrievalOptions {
                status: Some(String::new()),
                query: Some(String::new()),
                known_as_of: Some(String::new()),
                ..TaskRetrievalOptions::default()
            },
            Vec::new(),
        );
        assert!(statement.sql.ends_with("LIMIT $4"));
        assert!(!statement.sql.contains("overdue"));
        assert!(!statement.sql.contains("now()"));
    }

    #[test]
    fn rows_map_nulls_to_none() {
        let (hits, _) = search_with(&TaskRetrievalOptions::default(), vec![row()]);
        assert_eq!(
            hits,
            vec![TaskRetrievalHit {
                id: "t1".to_string(),
                title: "Tickets".to_string(),
                status: "planned".to_string(),
                due_at: None,
                created_at: "2025-01-01T00:00:00.000Z".to_string(),
            }]
        );
    }

    #[test]
    fn a_failing_statement_propagates() {
        let executor = RecordingExecutor::new(vec![Err(PgError::new("boom"))]);
        let error = drive_sync(search_tasks(
            &executor,
            &test_config(true, false),
            &test_scope(),
            &TaskRetrievalOptions::default(),
        ))
        .expect("bridge")
        .expect_err("the statement fails");
        assert_eq!(error, PgError::new("boom"));
    }
}
