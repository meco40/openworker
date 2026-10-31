//! Port of `src/server/world-model/retrieval/assertions.ts` (109 lines).
//!
//! | TypeScript | Rust |
//! | --- | --- |
//! | `assertions.ts:9-21` (`AssertionRetrievalHit`) | [`AssertionRetrievalHit`] |
//! | `assertions.ts:23-32` (`AssertionRetrievalOptions`) | [`AssertionRetrievalOptions`] |
//! | `assertions.ts:34-119` (`searchAssertions`) | [`search_assertions`] |
//! | `assertions.ts:95-102` (statement) | [`statement_sql`] |
//!
//! # Verified TypeScript quirks
//!
//! * The bitemporal predicates reuse **one** placeholder for two comparisons:
//!   `a.known_from <= $4` and `(a.known_to IS NULL OR a.known_to > $4)` share
//!   `$4` and only one value is pushed (`assertions.ts:55-58`); `relations.ts`
//!   spends two placeholders on the same pair. The port keeps the difference.
//! * Every optional option is tested for **truthiness**, so `status: ''`,
//!   `knownAsOf: ''`, `validAsOf: ''` and `query: ''` all take the default
//!   branch (`:46`, `:53`, `:62`, `:69`).
//! * `options.query` is lower-cased into a `%…%` pattern that is interpolated
//!   **three times** with one parameter (`:70-77`).
//! * `status` is a TypeScript union of three literals that omits `'cancelled'`
//!   although the column is the enum `world_model_assertion_status` with four
//!   members (`migrations/001_world_model.sql:18`); the port passes the string
//!   through, which is what the source does at runtime.
//! * `limit` is clamped (`Math.min(50, Math.max(1, …))`, `:41`) while
//!   `fulltext.ts` is not; the mapping of `:106-118` keeps `object_value`
//!   nullable and folds `source_observation_id` with `?? undefined`.
//!
//! The statement is one scoped transaction and the scope is a parameter
//! (`.tmp/s6s7-plan.md`, rule 7). The `enabled`/`e2eEnabled` gate of `:37-38`
//! runs before the statement; a failing statement propagates.

use crate::world_model::config::WorldModelConfig;
use crate::world_model::db::{
    scoped_query, NormalizedScope, PgError, PgExecutor, PgStatement, PgValue,
};

use super::{clamp_limit, row_number, row_optional_string, row_string};

/// `AssertionRetrievalHit` from `assertions.ts:9-21`.
#[derive(Debug, Clone, PartialEq)]
pub struct AssertionRetrievalHit {
    pub id: String,
    pub subject_name: String,
    pub predicate: String,
    pub object_value: Option<String>,
    /// `string` in the source — not the `Modality` union.
    pub modality: String,
    pub status: String,
    pub confidence: f64,
    pub known_from: Option<String>,
    pub known_to: Option<String>,
    pub valid_from: Option<String>,
    /// `row.source_observation_id ?? undefined`.
    pub source_observation_id: Option<String>,
}

/// `AssertionRetrievalOptions` from `assertions.ts:23-32`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AssertionRetrievalOptions {
    /// The union `'active' | 'superseded' | 'retracted'`; an empty string is
    /// falsy and selects the `'active'` default.
    pub status: Option<String>,
    /// Bitemporal: the knowledge time.
    pub known_as_of: Option<String>,
    /// Bitemporal: the validity time.
    pub valid_as_of: Option<String>,
    pub query: Option<String>,
    pub limit: Option<i64>,
}

/// The truthiness of an optional string — `if (options.x)`.
fn present(value: Option<&str>) -> Option<&str> {
    value.filter(|text| !text.is_empty())
}

/// The `WHERE` clause, the `LIMIT` placeholder and the parameters of
/// `assertions.ts:42-81`.
///
/// The scope values are the first three parameters. `paramIndex` starts at 4
/// and grows by one per *pushed* value, exactly like the post-increments of the
/// source, so a reused placeholder does not advance it.
fn build(
    scope: &NormalizedScope,
    options: &AssertionRetrievalOptions,
) -> (String, String, Vec<PgValue>) {
    let mut conditions = vec![
        "a.user_id = $1".to_string(),
        "a.persona_id = $2".to_string(),
        "a.workspace_id = $3".to_string(),
    ];
    let mut params = vec![
        PgValue::text(scope.user_id.as_str()),
        PgValue::text(scope.persona_id.as_str()),
        PgValue::text(scope.workspace_id.as_str()),
    ];
    let mut param_index = 4;

    if let Some(status) = present(options.status.as_deref()) {
        conditions.push(format!("a.status = ${param_index}"));
        params.push(PgValue::text(status));
        param_index += 1;
    } else {
        conditions.push("a.status = 'active'".to_string());
    }

    if let Some(known_as_of) = present(options.known_as_of.as_deref()) {
        let known_as_of_param = format!("${param_index}");
        conditions.push(format!("a.known_from <= {known_as_of_param}"));
        params.push(PgValue::text(known_as_of));
        conditions.push(format!(
            "(a.known_to IS NULL OR a.known_to > {known_as_of_param})"
        ));
        param_index += 1;
    } else {
        conditions.push("a.known_to IS NULL".to_string());
    }

    if let Some(valid_as_of) = present(options.valid_as_of.as_deref()) {
        let valid_as_of_param = format!("${param_index}");
        conditions.push(format!("a.valid_from <= {valid_as_of_param}"));
        params.push(PgValue::text(valid_as_of));
        conditions.push(format!(
            "(a.valid_to IS NULL OR a.valid_to > {valid_as_of_param})"
        ));
        param_index += 1;
    }

    if let Some(query) = present(options.query.as_deref()) {
        let like = format!("%{}%", query.to_lowercase());
        let query_param = format!("${param_index}");
        conditions.push(format!(
            "(\n      LOWER(e.canonical_name) LIKE {query_param}\n      OR LOWER(a.object_value) LIKE {query_param}\n      OR LOWER(a.predicate) LIKE {query_param}\n    )"
        ));
        params.push(PgValue::text(like));
        param_index += 1;
    }

    let limit_param = format!("${param_index}");
    params.push(PgValue::int(clamp_limit(options.limit.unwrap_or(10))));
    (conditions.join(" AND "), limit_param, params)
}

/// The statement of `assertions.ts:95-102`, token for token.
fn statement_sql(conditions: &str, limit_param: &str) -> String {
    format!("SELECT a.id, e.canonical_name AS subject_name, a.predicate, a.object_value,\n            a.modality, a.status, a.confidence, a.known_from, a.known_to,\n            a.valid_from, a.source_observation_id\n     FROM world_model_assertions a\n     JOIN world_model_entities e ON e.id = a.subject_id\n     WHERE {conditions}\n     ORDER BY a.confidence DESC\n     LIMIT {limit_param}")
}

/// `searchAssertions(options)` — `assertions.ts:34-119`.
///
/// The config gate answers `[]` without a statement; otherwise the statement is
/// one scoped transaction.
pub async fn search_assertions(
    executor: &dyn PgExecutor,
    config: &WorldModelConfig,
    scope: &NormalizedScope,
    options: &AssertionRetrievalOptions,
) -> Result<Vec<AssertionRetrievalHit>, PgError> {
    if !config.enabled && !config.e2e_enabled {
        return Ok(Vec::new());
    }

    let (conditions, limit_param, params) = build(scope, options);
    let statement = PgStatement::with_params(statement_sql(&conditions, &limit_param), params);
    let result = scoped_query::<PgError>(executor, scope, statement).await?;

    Ok(result
        .rows
        .iter()
        .map(|row| AssertionRetrievalHit {
            id: row_string(row, "id"),
            subject_name: row_string(row, "subject_name"),
            predicate: row_string(row, "predicate"),
            object_value: row_optional_string(row, "object_value"),
            modality: row_string(row, "modality"),
            status: row_string(row, "status"),
            confidence: row_number(row, "confidence"),
            known_from: row_optional_string(row, "known_from"),
            known_to: row_optional_string(row, "known_to"),
            valid_from: row_optional_string(row, "valid_from"),
            source_observation_id: row_optional_string(row, "source_observation_id"),
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world_model::db::testing::{Recorded, RecordingExecutor};
    use crate::world_model::db::{drive_sync, PgQueryResult, PgRow, SQL_BEGIN, SQL_COMMIT};
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

    fn search(options: &AssertionRetrievalOptions) -> Result<Vec<AssertionRetrievalHit>, PgError> {
        let executor = RecordingExecutor::new(vec![Ok(PgQueryResult::empty())]);
        let hits = drive_sync(search_assertions(
            &executor,
            &test_config(true, false),
            &test_scope(),
            options,
        ))
        .expect("bridge")
        .expect("scoped query");
        assert!(hits.is_empty());
        Ok(hits)
    }

    /// `searchAssertions` with a scripted row and an observable statement.
    fn search_with(
        options: &AssertionRetrievalOptions,
        rows: Vec<PgRow>,
    ) -> (Vec<AssertionRetrievalHit>, PgStatement) {
        let executor = RecordingExecutor::new(vec![Ok(PgQueryResult::from_rows(rows))]);
        let hits = drive_sync(search_assertions(
            &executor,
            &test_config(true, false),
            &test_scope(),
            options,
        ))
        .expect("bridge")
        .expect("scoped query");
        let statement = statement_of(&executor);
        (hits, statement)
    }

    fn row() -> PgRow {
        json!({
            "id": "a1",
            "subject_name": "Mira",
            "predicate": "mag",
            "object_value": null,
            "modality": "reported",
            "status": "active",
            "confidence": 0.8,
            "known_from": "2025-01-01T00:00:00.000Z",
            "known_to": null,
            "valid_from": null,
            "source_observation_id": null,
        })
        .as_object()
        .unwrap()
        .clone()
    }

    #[test]
    fn a_disabled_config_answers_empty_without_a_statement() {
        let executor = RecordingExecutor::new(Vec::new());
        let hits = drive_sync(search_assertions(
            &executor,
            &test_config(false, false),
            &test_scope(),
            &AssertionRetrievalOptions::default(),
        ))
        .expect("bridge")
        .expect("gate");
        assert!(hits.is_empty());
        assert!(executor.calls().is_empty());

        // `enableWorldModelE2E` (`:38`) opens the same gate.
        let e2e = RecordingExecutor::new(vec![Ok(PgQueryResult::empty())]);
        drive_sync(search_assertions(
            &e2e,
            &test_config(false, true),
            &test_scope(),
            &AssertionRetrievalOptions::default(),
        ))
        .expect("bridge")
        .expect("e2e gate");
        assert!(!e2e.calls().is_empty());
    }

    #[test]
    fn the_default_statement_matches_the_source() {
        search(&AssertionRetrievalOptions::default()).expect("search");
        let executor = RecordingExecutor::new(vec![Ok(PgQueryResult::empty())]);
        drive_sync(search_assertions(
            &executor,
            &test_config(true, false),
            &test_scope(),
            &AssertionRetrievalOptions::default(),
        ))
        .expect("bridge")
        .expect("scoped query");
        let statement = statement_of(&executor);
        assert_eq!(
            statement.sql,
            "SELECT a.id, e.canonical_name AS subject_name, a.predicate, a.object_value,\n            a.modality, a.status, a.confidence, a.known_from, a.known_to,\n            a.valid_from, a.source_observation_id\n     FROM world_model_assertions a\n     JOIN world_model_entities e ON e.id = a.subject_id\n     WHERE a.user_id = $1 AND a.persona_id = $2 AND a.workspace_id = $3 AND a.status = 'active' AND a.known_to IS NULL\n     ORDER BY a.confidence DESC\n     LIMIT $4"
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

    /// Every option branch advances the parameter index once — including the
    /// reused bitemporal placeholder of `:55-58` and `:63-66`.
    #[test]
    fn every_option_branch_advances_the_param_index_once() {
        let (_, statement) = search_with(
            &AssertionRetrievalOptions {
                status: Some("superseded".to_string()),
                known_as_of: Some("2024-01-01T00:00:00.000Z".to_string()),
                valid_as_of: Some("2024-02-01T00:00:00.000Z".to_string()),
                query: Some("Kino".to_string()),
                limit: Some(80),
            },
            Vec::new(),
        );
        assert!(
            statement.sql.contains(
                "AND a.status = $4 AND a.known_from <= $5 AND (a.known_to IS NULL OR a.known_to > $5) AND a.valid_from <= $6 AND (a.valid_to IS NULL OR a.valid_to > $6) AND (\n      LOWER(e.canonical_name) LIKE $7\n      OR LOWER(a.object_value) LIKE $7\n      OR LOWER(a.predicate) LIKE $7\n    )"
            ),
            "{}",
            statement.sql
        );
        assert!(statement.sql.ends_with("LIMIT $8"), "{}", statement.sql);
        assert_eq!(
            statement.params,
            vec![
                PgValue::text("u1"),
                PgValue::text("p1"),
                PgValue::text("w1"),
                PgValue::text("superseded"),
                PgValue::text("2024-01-01T00:00:00.000Z"),
                PgValue::text("2024-02-01T00:00:00.000Z"),
                PgValue::text("%kino%"),
                PgValue::int(50),
            ],
            "`Math.min(50, Math.max(1, 80))` is 50"
        );
        assert!(!statement.sql.contains("a.known_to IS NULL AND"));
    }

    /// Every option is truthiness-tested, so an empty string takes the default
    /// branch (`:46`, `:53`, `:62`, `:69`).
    #[test]
    fn empty_options_take_the_default_branches() {
        let (_, statement) = search_with(
            &AssertionRetrievalOptions {
                status: Some(String::new()),
                known_as_of: Some(String::new()),
                valid_as_of: Some(String::new()),
                query: Some(String::new()),
                limit: None,
            },
            Vec::new(),
        );
        assert_eq!(
            statement.sql,
            "SELECT a.id, e.canonical_name AS subject_name, a.predicate, a.object_value,\n            a.modality, a.status, a.confidence, a.known_from, a.known_to,\n            a.valid_from, a.source_observation_id\n     FROM world_model_assertions a\n     JOIN world_model_entities e ON e.id = a.subject_id\n     WHERE a.user_id = $1 AND a.persona_id = $2 AND a.workspace_id = $3 AND a.status = 'active' AND a.known_to IS NULL\n     ORDER BY a.confidence DESC\n     LIMIT $4"
        );
    }

    /// The clamp of `:41` bounds both ends.
    #[test]
    fn the_limit_is_clamped_into_one_to_fifty() {
        for (requested, bound) in [
            (1_i64, PgValue::int(1)),
            (-5, PgValue::int(1)),
            (10, PgValue::int(10)),
            (50, PgValue::int(50)),
            (80, PgValue::int(50)),
        ] {
            let (_, statement) = search_with(
                &AssertionRetrievalOptions {
                    limit: Some(requested),
                    ..AssertionRetrievalOptions::default()
                },
                Vec::new(),
            );
            assert_eq!(
                statement.params.last().cloned(),
                Some(bound),
                "limit {requested}"
            );
        }
    }

    #[test]
    fn rows_map_to_the_hit_shape() {
        let (hits, _) = search_with(&AssertionRetrievalOptions::default(), vec![row()]);
        assert_eq!(
            hits,
            vec![AssertionRetrievalHit {
                id: "a1".to_string(),
                subject_name: "Mira".to_string(),
                predicate: "mag".to_string(),
                object_value: None,
                modality: "reported".to_string(),
                status: "active".to_string(),
                confidence: 0.8,
                known_from: Some("2025-01-01T00:00:00.000Z".to_string()),
                known_to: None,
                valid_from: None,
                source_observation_id: None,
            }]
        );
    }

    #[test]
    fn the_statement_runs_between_begin_and_commit() {
        let executor = RecordingExecutor::new(vec![Ok(PgQueryResult::from_rows(vec![row()]))]);
        drive_sync(search_assertions(
            &executor,
            &test_config(true, false),
            &test_scope(),
            &AssertionRetrievalOptions::default(),
        ))
        .expect("bridge")
        .expect("scoped query");
        let sqls: Vec<String> = executor
            .calls()
            .iter()
            .filter(|call| !matches!(call, Recorded::Release))
            .map(|call| call.sql().to_string())
            .collect();
        assert_eq!(sqls.first().map(String::as_str), Some(SQL_BEGIN));
        assert_eq!(sqls.last().map(String::as_str), Some(SQL_COMMIT));
        assert_eq!(executor.calls().last(), Some(&Recorded::Release));
    }

    #[test]
    fn a_failing_statement_propagates() {
        let executor = RecordingExecutor::new(vec![Err(PgError::new("boom"))]);
        let error = drive_sync(search_assertions(
            &executor,
            &test_config(true, false),
            &test_scope(),
            &AssertionRetrievalOptions::default(),
        ))
        .expect("bridge")
        .expect_err("the statement fails");
        assert_eq!(error, PgError::new("boom"));
    }
}
