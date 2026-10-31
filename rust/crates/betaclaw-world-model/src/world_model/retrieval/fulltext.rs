//! Port of `src/server/world-model/retrieval/fulltext.ts` (72 lines).
//!
//! | TypeScript | Rust |
//! | --- | --- |
//! | `fulltext.ts:4-13` (`FullTextHit`) | [`FullTextHit`] |
//! | `fulltext.ts:19-76` (`fullTextSearchAssertions`) | [`full_text_search_assertions`] |
//! | `fulltext.ts:57-62` (statement) | [`statement_sql`] |
//!
//! # Verified TypeScript quirks
//!
//! * Unlike `assertions.ts`, `tasks.ts`, `relations.ts`, `openLoops.ts` and
//!   `vector.ts`, this module has **no** `getWorldModelConfig()` gate — the
//!   `enabled`/`e2eEnabled` check of `index.ts:99-101` covers it, so the port
//!   takes no config.
//! * `limit` is used as it arrives: there is **no**
//!   `Math.min(50, Math.max(1, …))` clamp here (`:24`), only the `= 10` default
//!   of the callers.
//! * `conditions.splice(4, 1, …)` (`:42`) *replaces* `known_to IS NULL` (index
//!   4) by two conditions and thereby moves the `to_tsvector` condition to the
//!   end: the bitemporal statement filters before the full-text one.
//! * `limitParam` is a literal (`5` or `6`, `:40-46`) and the same value is
//!   interpolated into `LIMIT $${limitParam}` (`:62`), so the limit placeholder
//!   follows the two optional conditions.
//! * `row.object_value ?? ''` (`:69`) folds `NULL` into the empty string while
//!   `source_observation_id` stays `undefined`.
//! * The failing statement propagates; the source has no `try`/`catch`.
//!
//! The statement is one scoped transaction (`BEGIN` →
//! `world_model_set_scope` → statement → `COMMIT`) and the scope is a parameter,
//! because `AsyncLocalStorage` has no Rust counterpart
//! (`.tmp/s6s7-plan.md`, rule 7).

use serde_json::Value;

use crate::world_model::db::{
    scoped_query, NormalizedScope, PgError, PgExecutor, PgRow, PgStatement, PgValue,
};
use crate::world_model::types::Modality;

use super::{row_number, row_optional_string, row_string};

/// `FullTextHit` from `fulltext.ts:4-13`.
#[derive(Debug, Clone, PartialEq)]
pub struct FullTextHit {
    pub id: String,
    pub predicate: String,
    /// `row.object_value ?? ''`.
    pub object_value: String,
    pub modality: Modality,
    pub status: String,
    pub confidence: f64,
    /// `row.source_observation_id ?? undefined`.
    pub source_observation_id: Option<String>,
    /// `row.known_from` — non-null in the source type and in the schema.
    pub known_from: String,
}

/// The `options` parameter of `fullTextSearchAssertions` — `fulltext.ts:25`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FullTextOptions {
    /// Bitemporal: the knowledge time of the question.
    pub known_as_of: Option<String>,
}

/// The condition list and the limit placeholder of one call —
/// `fulltext.ts:31-46`.
///
/// Returns `(conditions.join(' AND '), limitParam)`.
fn conditions(known_as_of: Option<&str>) -> (String, usize) {
    let mut conditions = vec![
        "user_id = $1".to_string(),
        "persona_id = $2".to_string(),
        "workspace_id = $3".to_string(),
        "status = 'active'".to_string(),
        "known_to IS NULL".to_string(),
        "to_tsvector('simple', concat_ws(' ', predicate, object_value)) @@ plainto_tsquery('simple', $4)".to_string(),
    ];
    let mut limit_param = 5;
    if known_as_of.is_some() {
        // `conditions.splice(4, 1, 'known_from <= $5', '(known_to IS NULL OR
        // known_to > $5)')`.
        conditions.splice(
            4..5,
            [
                "known_from <= $5".to_string(),
                "(known_to IS NULL OR known_to > $5)".to_string(),
            ],
        );
        limit_param = 6;
    }
    (conditions.join(" AND "), limit_param)
}

/// The statement of `fulltext.ts:57-62`, token for token.
///
/// The text is written as one literal with explicit `\n` escapes: the SQL is
/// line-structured like the source template literal, while a `\`-continued Rust
/// literal would strip the indentation of the following line.
fn statement_sql(conditions: &str, limit_param: usize) -> String {
    format!("SELECT id, predicate, object_value, modality, status, confidence,\n            source_observation_id, known_from\n     FROM world_model_assertions\n     WHERE {conditions}\n     ORDER BY confidence DESC, known_from DESC\n     LIMIT ${limit_param}")
}

/// `fullTextSearchAssertions(userId, personaId, workspaceId, query, limit,
/// options)` — `fulltext.ts:19-76`.
///
/// A whitespace-only query answers `[]` without a statement (`:27-28`).
pub async fn full_text_search_assertions(
    executor: &dyn PgExecutor,
    scope: &NormalizedScope,
    query: &str,
    limit: i64,
    options: &FullTextOptions,
) -> Result<Vec<FullTextHit>, PgError> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }

    // `if (options?.knownAsOf)` — truthiness, so `''` takes the else branch.
    let known_as_of = options
        .known_as_of
        .as_deref()
        .filter(|value| !value.is_empty());
    let (where_clause, limit_param) = conditions(known_as_of);
    let mut params = vec![
        PgValue::text(scope.user_id.as_str()),
        PgValue::text(scope.persona_id.as_str()),
        PgValue::text(scope.workspace_id.as_str()),
        PgValue::text(trimmed),
    ];
    if let Some(known_as_of) = known_as_of {
        params.push(PgValue::text(known_as_of));
    }
    params.push(PgValue::int(limit));

    let statement = PgStatement::with_params(statement_sql(&where_clause, limit_param), params);
    let result = scoped_query::<PgError>(executor, scope, statement).await?;

    Ok(result
        .rows
        .iter()
        .map(|row| FullTextHit {
            id: row_string(row, "id"),
            predicate: row_string(row, "predicate"),
            object_value: row_string(row, "object_value"),
            modality: modality(row),
            status: row_string(row, "status"),
            confidence: row_number(row, "confidence"),
            source_observation_id: row_optional_string(row, "source_observation_id"),
            known_from: row_string(row, "known_from"),
        })
        .collect())
}

/// `row.modality` as the [`Modality`] union of `types.ts:1-8`.
///
/// The column is the PostgreSQL enum `world_model_modality`
/// (`migrations/001_world_model.sql:13-15`), so the union is enforced by the
/// database and a value outside it cannot occur. Should a driver ever hand one
/// over, the port reports the column default `'reported'`
/// (`001_world_model.sql:102`) instead of failing; `structured.rs` documents the
/// same choice for `EventStatus`, which has an `unknown` member and uses it.
fn modality(row: &PgRow) -> Modality {
    match row.get("modality") {
        Some(Value::String(text)) => {
            serde_json::from_value::<Modality>(Value::String(text.clone()))
                .unwrap_or(Modality::Reported)
        }
        _ => Modality::Reported,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world_model::db::testing::{Recorded, RecordingExecutor};
    use crate::world_model::db::{
        drive_sync, PgQueryResult, SQL_BEGIN, SQL_COMMIT, SQL_ROLLBACK, SQL_SET_SCOPE,
    };
    use serde_json::json;

    fn scope() -> NormalizedScope {
        NormalizedScope {
            user_id: "u1".to_string(),
            persona_id: "p1".to_string(),
            workspace_id: "w1".to_string(),
        }
    }

    fn statements(executor: &RecordingExecutor) -> Vec<String> {
        executor
            .calls()
            .iter()
            .filter(|call| !matches!(call, Recorded::Release))
            .map(|call| call.sql().to_string())
            .collect()
    }

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

    fn row() -> PgRow {
        json!({
            "id": "a1",
            "predicate": "mag",
            "object_value": null,
            "modality": "reported",
            "status": "active",
            "confidence": 0.9,
            "source_observation_id": null,
            "known_from": "2025-01-01T00:00:00.000Z",
        })
        .as_object()
        .unwrap()
        .clone()
    }

    #[test]
    fn an_empty_query_issues_no_statement() {
        let executor = RecordingExecutor::new(Vec::new());
        let empty = drive_sync(full_text_search_assertions(
            &executor,
            &scope(),
            "   ",
            10,
            &FullTextOptions::default(),
        ))
        .expect("bridge")
        .expect("no statement");
        assert!(empty.is_empty());
        assert!(executor.calls().is_empty());
    }

    /// The `WHERE` clause of `fulltext.ts:31-39` with the `LIMIT $5` of `:40-46`.
    #[test]
    fn the_statement_matches_the_source_without_known_as_of() {
        let executor = RecordingExecutor::new(vec![Ok(PgQueryResult::empty())]);
        let hits = drive_sync(full_text_search_assertions(
            &executor,
            &scope(),
            "  kino ",
            10,
            &FullTextOptions::default(),
        ))
        .expect("bridge")
        .expect("scoped query");
        assert!(hits.is_empty());
        assert_eq!(
            statements(&executor),
            vec![
                SQL_BEGIN.to_string(),
                SQL_SET_SCOPE.to_string(),
                "SELECT id, predicate, object_value, modality, status, confidence,\n            source_observation_id, known_from\n     FROM world_model_assertions\n     WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3 AND status = 'active' AND known_to IS NULL AND to_tsvector('simple', concat_ws(' ', predicate, object_value)) @@ plainto_tsquery('simple', $4)\n     ORDER BY confidence DESC, known_from DESC\n     LIMIT $5"
                    .to_string(),
                SQL_COMMIT.to_string(),
            ]
        );
        assert_eq!(
            statement_of(&executor).params,
            vec![
                PgValue::text("u1"),
                PgValue::text("p1"),
                PgValue::text("w1"),
                PgValue::text("kino"),
                PgValue::int(10),
            ]
        );
    }

    /// `conditions.splice(4, 1, …)` moves the tsquery condition behind the two
    /// bitemporal ones and the limit becomes `$6`.
    #[test]
    fn known_as_of_replaces_the_known_to_condition_before_the_tsquery() {
        let executor = RecordingExecutor::new(vec![Ok(PgQueryResult::empty())]);
        drive_sync(full_text_search_assertions(
            &executor,
            &scope(),
            "kino",
            5,
            &FullTextOptions {
                known_as_of: Some("2024-02-03T00:00:00.000Z".to_string()),
            },
        ))
        .expect("bridge")
        .expect("scoped query");
        let statement = statement_of(&executor);
        assert_eq!(
            statement.sql,
            "SELECT id, predicate, object_value, modality, status, confidence,\n            source_observation_id, known_from\n     FROM world_model_assertions\n     WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3 AND status = 'active' AND known_from <= $5 AND (known_to IS NULL OR known_to > $5) AND to_tsvector('simple', concat_ws(' ', predicate, object_value)) @@ plainto_tsquery('simple', $4)\n     ORDER BY confidence DESC, known_from DESC\n     LIMIT $6"
        );
        assert_eq!(
            statement.params,
            vec![
                PgValue::text("u1"),
                PgValue::text("p1"),
                PgValue::text("w1"),
                PgValue::text("kino"),
                PgValue::text("2024-02-03T00:00:00.000Z"),
                PgValue::int(5),
            ]
        );
    }

    /// An empty `knownAsOf` is falsy in the source and takes the else branch.
    #[test]
    fn an_empty_known_as_of_is_ignored() {
        let executor = RecordingExecutor::new(vec![Ok(PgQueryResult::empty())]);
        drive_sync(full_text_search_assertions(
            &executor,
            &scope(),
            "kino",
            5,
            &FullTextOptions {
                known_as_of: Some(String::new()),
            },
        ))
        .expect("bridge")
        .expect("scoped query");
        assert!(statement_of(&executor).sql.ends_with("LIMIT $5"));
    }

    #[test]
    fn rows_map_null_object_values_to_the_empty_string() {
        let executor = RecordingExecutor::new(vec![Ok(PgQueryResult::from_rows(vec![row()]))]);
        let hits = drive_sync(full_text_search_assertions(
            &executor,
            &scope(),
            "kino",
            5,
            &FullTextOptions::default(),
        ))
        .expect("bridge")
        .expect("scoped query");
        assert_eq!(
            hits,
            vec![FullTextHit {
                id: "a1".to_string(),
                predicate: "mag".to_string(),
                object_value: String::new(),
                modality: Modality::Reported,
                status: "active".to_string(),
                confidence: 0.9,
                source_observation_id: None,
                known_from: "2025-01-01T00:00:00.000Z".to_string(),
            }]
        );
        assert_eq!(executor.calls().last(), Some(&Recorded::Release));
    }

    #[test]
    fn a_failing_statement_propagates_and_rolls_back() {
        let executor = RecordingExecutor::new(vec![Err(PgError::new("boom"))]);
        let error = drive_sync(full_text_search_assertions(
            &executor,
            &scope(),
            "kino",
            5,
            &FullTextOptions::default(),
        ))
        .expect("bridge")
        .expect_err("the statement fails");
        assert_eq!(error, PgError::new("boom"));
        assert_eq!(
            statements(&executor)
                .last()
                .map(String::as_str)
                .unwrap_or_default(),
            SQL_ROLLBACK
        );
    }
}
