//! Port of `src/server/world-model/retrieval/relations.ts` (95 lines).
//!
//! | TypeScript | Rust |
//! | --- | --- |
//! | `relations.ts:9-16` (`RelationRetrievalHit`) | [`RelationRetrievalHit`] |
//! | `relations.ts:18-27` (`RelationRetrievalOptions`) | [`RelationRetrievalOptions`] |
//! | `relations.ts:29-107` (`searchRelations`) | [`search_relations`] |
//! | `relations.ts:87-95` (statement) | [`statement_sql`] |
//!
//! # Verified TypeScript quirks
//!
//! * Where `assertions.ts:55-58` reuses one placeholder for the pair
//!   `known_from <= x` / `(known_to IS NULL OR known_to > x)`, this module spends
//!   **two** (`relations.ts:51-54`) and pushes the same value twice; the
//!   `valid_as_of` pair of `:72-75` does the same. The port keeps both forms.
//! * `if (!options.validAsOf) conditions.push('r.valid_to IS NULL')` (`:46-48`)
//!   adds the open-ended validity only when *no* as-of value is given.
//! * `r.known_to IS NULL` is part of the base condition list (`:41`), so
//!   `known_as_of` only bounds `known_from` and `known_to` from above.
//! * Both `entityName` and `relationType` are truthiness-tested (`:57`, `:62`).
//! * `entityName` is lower-cased into one `%…%` pattern used for the source
//!   *and* the target name (`:63-66`).
//! * After every push the index equals `params.length`, so
//!   `LIMIT $${idx}` (`:95`) is always `$<params.length>`.
//!
//! The statement is one scoped transaction and the scope is a parameter
//! (`.tmp/s6s7-plan.md`, rule 7); the `enabled`/`e2eEnabled` gate of `:32-33`
//! runs before it and a failing statement propagates.

use crate::world_model::config::WorldModelConfig;
use crate::world_model::db::{
    scoped_query, NormalizedScope, PgError, PgExecutor, PgStatement, PgValue,
};

use super::{clamp_limit, row_number, row_optional_string, row_string};

/// `RelationRetrievalHit` from `relations.ts:9-16`.
#[derive(Debug, Clone, PartialEq)]
pub struct RelationRetrievalHit {
    pub id: String,
    pub source_entity_name: String,
    pub target_entity_name: String,
    pub relation_type: String,
    pub confidence: f64,
    pub valid_from: Option<String>,
}

/// `RelationRetrievalOptions` from `relations.ts:18-27`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RelationRetrievalOptions {
    pub relation_type: Option<String>,
    pub entity_name: Option<String>,
    pub valid_as_of: Option<String>,
    pub known_as_of: Option<String>,
    pub limit: Option<i64>,
}

/// The truthiness of an optional string — `if (options.x)`.
fn present(value: Option<&str>) -> Option<&str> {
    value.filter(|text| !text.is_empty())
}

/// The `WHERE` clause, the `LIMIT` placeholder and the parameters of
/// `relations.ts:37-78`.
fn build(
    scope: &NormalizedScope,
    options: &RelationRetrievalOptions,
) -> (String, String, Vec<PgValue>) {
    let mut conditions = vec![
        "r.user_id = $1".to_string(),
        "r.persona_id = $2".to_string(),
        "r.workspace_id = $3".to_string(),
        "r.known_to IS NULL".to_string(),
    ];
    let mut params = vec![
        PgValue::text(scope.user_id.as_str()),
        PgValue::text(scope.persona_id.as_str()),
        PgValue::text(scope.workspace_id.as_str()),
    ];
    let mut index = 4;

    let valid_as_of = present(options.valid_as_of.as_deref());
    if valid_as_of.is_none() {
        conditions.push("r.valid_to IS NULL".to_string());
    }

    if let Some(known_as_of) = present(options.known_as_of.as_deref()) {
        conditions.push(format!("r.known_from <= ${index}"));
        params.push(PgValue::text(known_as_of));
        index += 1;
        conditions.push(format!("(r.known_to IS NULL OR r.known_to > ${index})"));
        params.push(PgValue::text(known_as_of));
        index += 1;
    }

    if let Some(relation_type) = present(options.relation_type.as_deref()) {
        conditions.push(format!("r.relation_type = ${index}"));
        params.push(PgValue::text(relation_type));
        index += 1;
    }

    if let Some(entity_name) = present(options.entity_name.as_deref()) {
        let like = format!("%{}%", entity_name.to_lowercase());
        conditions.push(format!(
            "(LOWER(se.canonical_name) LIKE ${index} OR LOWER(te.canonical_name) LIKE ${index})"
        ));
        params.push(PgValue::text(like));
        index += 1;
    }

    if let Some(valid_as_of) = valid_as_of {
        conditions.push(format!("r.valid_from <= ${index}"));
        params.push(PgValue::text(valid_as_of));
        index += 1;
        conditions.push(format!("(r.valid_to IS NULL OR r.valid_to > ${index})"));
        params.push(PgValue::text(valid_as_of));
        index += 1;
    }

    params.push(PgValue::int(clamp_limit(options.limit.unwrap_or(10))));
    (conditions.join(" AND "), format!("${index}"), params)
}

/// The statement of `relations.ts:87-95`, token for token.
fn statement_sql(conditions: &str, limit_param: &str) -> String {
    format!("SELECT r.id, se.canonical_name AS source_entity_name,\n            te.canonical_name AS target_entity_name,\n            r.relation_type, r.confidence, r.valid_from\n     FROM world_model_entity_relations r\n     JOIN world_model_entities se ON se.id = r.source_entity_id\n     JOIN world_model_entities te ON te.id = r.target_entity_id\n     WHERE {conditions}\n     ORDER BY r.confidence DESC\n     LIMIT {limit_param}")
}

/// `searchRelations(options)` — `relations.ts:29-107`.
pub async fn search_relations(
    executor: &dyn PgExecutor,
    config: &WorldModelConfig,
    scope: &NormalizedScope,
    options: &RelationRetrievalOptions,
) -> Result<Vec<RelationRetrievalHit>, PgError> {
    if !config.enabled && !config.e2e_enabled {
        return Ok(Vec::new());
    }

    let (conditions, limit_param, params) = build(scope, options);
    let statement = PgStatement::with_params(statement_sql(&conditions, &limit_param), params);
    let result = scoped_query::<PgError>(executor, scope, statement).await?;

    Ok(result
        .rows
        .iter()
        .map(|row| RelationRetrievalHit {
            id: row_string(row, "id"),
            source_entity_name: row_string(row, "source_entity_name"),
            target_entity_name: row_string(row, "target_entity_name"),
            relation_type: row_string(row, "relation_type"),
            confidence: row_number(row, "confidence"),
            valid_from: row_optional_string(row, "valid_from"),
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
        options: &RelationRetrievalOptions,
        rows: Vec<PgRow>,
    ) -> (Vec<RelationRetrievalHit>, PgStatement) {
        let executor = RecordingExecutor::new(vec![Ok(PgQueryResult::from_rows(rows))]);
        let hits = drive_sync(search_relations(
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
            "id": "r1",
            "source_entity_name": "Mira",
            "target_entity_name": "Noah",
            "relation_type": "knows",
            "confidence": 0.7,
            "valid_from": null,
        })
        .as_object()
        .unwrap()
        .clone()
    }

    #[test]
    fn a_disabled_config_answers_empty_without_a_statement() {
        let executor = RecordingExecutor::new(Vec::new());
        let hits = drive_sync(search_relations(
            &executor,
            &test_config(false, false),
            &test_scope(),
            &RelationRetrievalOptions::default(),
        ))
        .expect("bridge")
        .expect("gate");
        assert!(hits.is_empty());
        assert!(executor.calls().is_empty());
    }

    /// The base list of `relations.ts:37-42` plus `r.valid_to IS NULL` (`:47`).
    #[test]
    fn the_default_statement_adds_the_open_ended_validity() {
        let (_, statement) = search_with(&RelationRetrievalOptions::default(), Vec::new());
        assert_eq!(
            statement.sql,
            "SELECT r.id, se.canonical_name AS source_entity_name,\n            te.canonical_name AS target_entity_name,\n            r.relation_type, r.confidence, r.valid_from\n     FROM world_model_entity_relations r\n     JOIN world_model_entities se ON se.id = r.source_entity_id\n     JOIN world_model_entities te ON te.id = r.target_entity_id\n     WHERE r.user_id = $1 AND r.persona_id = $2 AND r.workspace_id = $3 AND r.known_to IS NULL AND r.valid_to IS NULL\n     ORDER BY r.confidence DESC\n     LIMIT $4"
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

    /// `validAsOf` replaces the open-ended condition and spends two
    /// placeholders on the pair (`relations.ts:72-76`).
    #[test]
    fn valid_as_of_bounds_the_validity_interval() {
        let (_, statement) = search_with(
            &RelationRetrievalOptions {
                valid_as_of: Some("2024-02-01T00:00:00.000Z".to_string()),
                ..RelationRetrievalOptions::default()
            },
            Vec::new(),
        );
        assert!(
            statement.sql.contains(
                "AND r.known_to IS NULL AND r.valid_from <= $4 AND (r.valid_to IS NULL OR r.valid_to > $5)\n     ORDER BY"
            ),
            "{}",
            statement.sql
        );
        assert!(statement.sql.ends_with("LIMIT $6"), "{}", statement.sql);
        assert_eq!(
            statement.params,
            vec![
                PgValue::text("u1"),
                PgValue::text("p1"),
                PgValue::text("w1"),
                PgValue::text("2024-02-01T00:00:00.000Z"),
                PgValue::text("2024-02-01T00:00:00.000Z"),
                PgValue::int(10),
            ]
        );
    }

    /// `knownAsOf` also spends two placeholders (`relations.ts:51-54`) and
    /// leaves `r.valid_to IS NULL` in place.
    #[test]
    fn known_as_of_bounds_the_knowledge_interval() {
        let (_, statement) = search_with(
            &RelationRetrievalOptions {
                known_as_of: Some("2024-01-01T00:00:00.000Z".to_string()),
                ..RelationRetrievalOptions::default()
            },
            Vec::new(),
        );
        assert!(
            statement.sql.contains(
                "AND r.known_to IS NULL AND r.valid_to IS NULL AND r.known_from <= $4 AND (r.known_to IS NULL OR r.known_to > $5)\n     ORDER BY"
            ),
            "{}",
            statement.sql
        );
        assert_eq!(
            statement.params,
            vec![
                PgValue::text("u1"),
                PgValue::text("p1"),
                PgValue::text("w1"),
                PgValue::text("2024-01-01T00:00:00.000Z"),
                PgValue::text("2024-01-01T00:00:00.000Z"),
                PgValue::int(10),
            ]
        );
    }

    /// The branch order of `relations.ts:50-78`: `knownAsOf`, `relationType`,
    /// `entityName`, `validAsOf`, then the limit.
    #[test]
    fn the_optional_branches_follow_the_source_order() {
        let (_, statement) = search_with(
            &RelationRetrievalOptions {
                known_as_of: Some("2024-01-01T00:00:00.000Z".to_string()),
                relation_type: Some("knows".to_string()),
                entity_name: Some("MIRA".to_string()),
                valid_as_of: Some("2024-02-01T00:00:00.000Z".to_string()),
                limit: Some(80),
            },
            Vec::new(),
        );
        assert!(
            statement.sql.contains(
                "AND r.known_from <= $4 AND (r.known_to IS NULL OR r.known_to > $5) AND r.relation_type = $6 AND (LOWER(se.canonical_name) LIKE $7 OR LOWER(te.canonical_name) LIKE $7) AND r.valid_from <= $8 AND (r.valid_to IS NULL OR r.valid_to > $9)"
            ),
            "{}",
            statement.sql
        );
        assert!(statement.sql.ends_with("LIMIT $10"), "{}", statement.sql);
        assert_eq!(
            statement.params,
            vec![
                PgValue::text("u1"),
                PgValue::text("p1"),
                PgValue::text("w1"),
                PgValue::text("2024-01-01T00:00:00.000Z"),
                PgValue::text("2024-01-01T00:00:00.000Z"),
                PgValue::text("knows"),
                PgValue::text("%mira%"),
                PgValue::text("2024-02-01T00:00:00.000Z"),
                PgValue::text("2024-02-01T00:00:00.000Z"),
                PgValue::int(50),
            ]
        );
    }

    #[test]
    fn empty_options_take_the_default_branches() {
        let (_, statement) = search_with(
            &RelationRetrievalOptions {
                relation_type: Some(String::new()),
                entity_name: Some(String::new()),
                valid_as_of: Some(String::new()),
                known_as_of: Some(String::new()),
                limit: None,
            },
            Vec::new(),
        );
        assert!(statement
            .sql
            .contains("AND r.known_to IS NULL AND r.valid_to IS NULL\n"));
        assert!(statement.sql.ends_with("LIMIT $4"));
    }

    #[test]
    fn rows_map_to_the_hit_shape() {
        let (hits, _) = search_with(&RelationRetrievalOptions::default(), vec![row()]);
        assert_eq!(
            hits,
            vec![RelationRetrievalHit {
                id: "r1".to_string(),
                source_entity_name: "Mira".to_string(),
                target_entity_name: "Noah".to_string(),
                relation_type: "knows".to_string(),
                confidence: 0.7,
                valid_from: None,
            }]
        );
    }

    #[test]
    fn a_failing_statement_propagates() {
        let executor = RecordingExecutor::new(vec![Err(PgError::new("boom"))]);
        let error = drive_sync(search_relations(
            &executor,
            &test_config(true, false),
            &test_scope(),
            &RelationRetrievalOptions::default(),
        ))
        .expect("bridge")
        .expect_err("the statement fails");
        assert_eq!(error, PgError::new("boom"));
    }
}
