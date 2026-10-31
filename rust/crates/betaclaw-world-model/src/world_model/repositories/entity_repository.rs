//! Port of `src/server/world-model/repositories/entityRepository.ts:1-255`.
//!
//! The explicit scope parameter replaces the TypeScript `AsyncLocalStorage`;
//! relation insertion remains atomic across ownership validation, replay
//! detection, supersession and insert.

use serde_json::{Map, Value};

use crate::world_model::db::{
    run_scoped, PgError, PgExecutor, PgQueryResult, PgRow, PgStatement, PgValue,
};
use crate::world_model::repositories::{ambient_query, normalized_scope, row_number, row_text};
use crate::world_model::scope::WorldModelScope;

#[derive(Debug, Clone, PartialEq)]
pub struct EntityRecord {
    pub id: String,
    pub user_id: String,
    pub persona_id: String,
    pub workspace_id: String,
    pub canonical_name: String,
    pub category: String,
    pub owner: String,
    pub properties: Value,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct EntityRelationInput {
    pub user_id: String,
    pub persona_id: String,
    pub workspace_id: String,
    pub source_entity_id: String,
    pub target_entity_id: String,
    pub relation_type: String,
    pub confidence: Option<f64>,
    pub valid_from: Option<String>,
    pub valid_to: Option<String>,
    pub known_from: Option<String>,
    pub source_observation_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct EntityRelationRecord {
    pub id: String,
    pub user_id: String,
    pub persona_id: String,
    pub workspace_id: String,
    pub source_entity_id: String,
    pub target_entity_id: String,
    pub relation_type: String,
    pub direction: String,
    pub confidence: f64,
    pub valid_from: String,
    pub valid_to: Option<String>,
    pub known_from: String,
    pub known_to: Option<String>,
    pub supersedes_relation_id: Option<String>,
    pub source_observation_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct EntityInput {
    pub user_id: String,
    pub persona_id: String,
    pub workspace_id: String,
    pub canonical_name: String,
    pub category: String,
    pub owner: Option<String>,
    pub properties: Option<Map<String, Value>>,
}

pub const SQL_UPSERT_ENTITY: &str = "INSERT INTO world_model_entities
      (user_id, persona_id, workspace_id, canonical_name, category, owner, properties)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (user_id, persona_id, workspace_id, canonical_name, owner) DO UPDATE SET
       properties = CASE WHEN $7::jsonb = '{}'::jsonb THEN world_model_entities.properties
         ELSE world_model_entities.properties || EXCLUDED.properties END,
       updated_at = now()
     RETURNING id, user_id, persona_id, workspace_id, canonical_name, category, owner, properties, created_at";

pub const SQL_FIND_ENTITY: &str = "SELECT id, user_id, persona_id, workspace_id, canonical_name, category, owner, properties, created_at
     FROM world_model_entities
     WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3 AND canonical_name = $4
     LIMIT 1";

const SQL_VALIDATE_RELATION_ENTITIES: &str = "SELECT id FROM world_model_entities
       WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3 AND id = ANY($4::uuid[])";
const SQL_RELATION_REPLAY: &str =
    "SELECT id, user_id, persona_id, workspace_id, source_entity_id, target_entity_id,
                relation_type, direction, confidence, valid_from, valid_to, known_from, known_to,
                supersedes_relation_id, source_observation_id
         FROM world_model_entity_relations
         WHERE source_observation_id = $1 AND source_entity_id = $2
           AND target_entity_id = $3 AND relation_type = $4
         LIMIT 1";
const SQL_SUPERSEDE_RELATIONS: &str = "UPDATE world_model_entity_relations SET known_to = $5
       WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3 AND source_entity_id = $4
         AND relation_type = $6 AND known_to IS NULL RETURNING id";
const SQL_INSERT_RELATION: &str = "INSERT INTO world_model_entity_relations
        (user_id, persona_id, workspace_id, source_entity_id, target_entity_id, relation_type,
         confidence, valid_from, valid_to, known_from, supersedes_relation_id, source_observation_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING id, user_id, persona_id, workspace_id, source_entity_id, target_entity_id, relation_type,
                 direction, confidence, valid_from, valid_to, known_from, known_to,
                 supersedes_relation_id, source_observation_id";

const SQL_ACTIVE_RELATIONS: &str = "SELECT id, user_id, persona_id, workspace_id, source_entity_id, target_entity_id, relation_type,
            direction, confidence, valid_from, valid_to, known_from, known_to,
            supersedes_relation_id, source_observation_id
     FROM world_model_entity_relations
     WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3
       AND known_to IS NULL AND valid_to IS NULL
     ORDER BY known_from ASC";
const SQL_RELATION_HISTORY: &str = "SELECT id, user_id, persona_id, workspace_id, source_entity_id, target_entity_id, relation_type,
            direction, confidence, valid_from, valid_to, known_from, known_to,
            supersedes_relation_id, source_observation_id
     FROM world_model_entity_relations
     WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3
       AND source_entity_id = $4 AND target_entity_id = $5 AND relation_type = $6
     ORDER BY known_from ASC";

fn optional_text(row: &PgRow, column: &str) -> Option<String> {
    match row.get(column) {
        Some(Value::String(text)) => Some(text.clone()),
        _ => None,
    }
}

fn entity_from_row(row: &PgRow) -> EntityRecord {
    EntityRecord {
        id: row_text(row, "id"),
        user_id: row_text(row, "user_id"),
        persona_id: row_text(row, "persona_id"),
        workspace_id: row_text(row, "workspace_id"),
        canonical_name: row_text(row, "canonical_name"),
        category: row_text(row, "category"),
        owner: row_text(row, "owner"),
        properties: row
            .get("properties")
            .cloned()
            .unwrap_or_else(|| serde_json::json!({})),
        created_at: row_text(row, "created_at"),
    }
}

fn relation_from_row(row: &PgRow) -> EntityRelationRecord {
    EntityRelationRecord {
        id: row_text(row, "id"),
        user_id: row_text(row, "user_id"),
        persona_id: row_text(row, "persona_id"),
        workspace_id: row_text(row, "workspace_id"),
        source_entity_id: row_text(row, "source_entity_id"),
        target_entity_id: row_text(row, "target_entity_id"),
        relation_type: row_text(row, "relation_type"),
        direction: row_text(row, "direction"),
        confidence: row_number(row, "confidence"),
        valid_from: row_text(row, "valid_from"),
        valid_to: optional_text(row, "valid_to"),
        known_from: row_text(row, "known_from"),
        known_to: optional_text(row, "known_to"),
        supersedes_relation_id: optional_text(row, "supersedes_relation_id"),
        source_observation_id: optional_text(row, "source_observation_id"),
    }
}

fn first_row<E: From<PgError>>(result: PgQueryResult, message: &'static str) -> Result<PgRow, E> {
    result
        .rows
        .into_iter()
        .next()
        .ok_or_else(|| E::from(PgError::new(message)))
}

pub const MISSING_ENTITY_ROW: &str = "[world-model] entity upsert returned no row";
pub const MISSING_RELATION_ROW: &str = "[world-model] relation insert returned no row";
pub const RELATION_SCOPE_ERROR: &str =
    "[world-model] relation entities must belong to the same user/persona scope";

/// `upsertEntity(input, db)` — `entityRepository.ts:91-125`.
pub async fn upsert_entity<E: From<PgError> + Send + 'static>(
    executor: &dyn PgExecutor,
    scope: Option<&WorldModelScope>,
    input: &EntityInput,
) -> Result<EntityRecord, E> {
    let properties = input.properties.clone().unwrap_or_default();
    let result = ambient_query::<E>(
        executor,
        scope,
        PgStatement::with_params(
            SQL_UPSERT_ENTITY,
            vec![
                PgValue::text(input.user_id.as_str()),
                PgValue::text(input.persona_id.as_str()),
                PgValue::text(input.workspace_id.as_str()),
                PgValue::text(input.canonical_name.as_str()),
                PgValue::text(input.category.as_str()),
                PgValue::text(input.owner.as_deref().unwrap_or("shared")),
                PgValue::text(Value::Object(properties).to_string()),
            ],
        ),
    )
    .await?;
    Ok(entity_from_row(&first_row(result, MISSING_ENTITY_ROW)?))
}

/// `findEntityByName` — `entityRepository.ts:127-147`.
pub async fn find_entity_by_name<E: From<PgError> + Send + 'static>(
    executor: &dyn PgExecutor,
    scope: Option<&WorldModelScope>,
    user_id: &str,
    persona_id: &str,
    workspace_id: &str,
    canonical_name: &str,
) -> Result<Option<EntityRecord>, E> {
    let result = ambient_query::<E>(
        executor,
        scope,
        PgStatement::with_params(
            SQL_FIND_ENTITY,
            vec![
                PgValue::text(user_id),
                PgValue::text(persona_id),
                PgValue::text(workspace_id),
                PgValue::text(canonical_name),
            ],
        ),
    )
    .await?;
    Ok(result.first().map(entity_from_row))
}

/// `insertRelation(input)` — `entityRepository.ts:149-224`.
///
/// The default TypeScript path encloses the four statements in one transaction;
/// the supplied Rust scope sets RLS on that checked-out connection.
pub async fn insert_relation<E: From<PgError> + Send + 'static>(
    executor: &dyn PgExecutor,
    scope: Option<&WorldModelScope>,
    input: &EntityRelationInput,
) -> Result<EntityRelationRecord, E> {
    let normalized = scope.map(normalized_scope);
    let input = input.clone();
    run_scoped::<EntityRelationRecord, E>(
        executor,
        normalized.as_ref(),
        Box::new(move |session| {
            Box::pin(async move { insert_relation_in::<E>(session.as_ref(), &input).await })
        }),
    )
    .await
}

/// The `insertRelation` callback on a caller-owned transaction session.
pub(crate) async fn insert_relation_in<E: From<PgError> + Send + 'static>(
    session: &dyn crate::world_model::db::PgSession,
    input: &EntityRelationInput,
) -> Result<EntityRelationRecord, E> {
    let entities = session
        .query(PgStatement::with_params(
            SQL_VALIDATE_RELATION_ENTITIES,
            vec![
                PgValue::text(input.user_id.as_str()),
                PgValue::text(input.persona_id.as_str()),
                PgValue::text(input.workspace_id.as_str()),
                PgValue::text_array(vec![
                    input.source_entity_id.clone(),
                    input.target_entity_id.clone(),
                ]),
            ],
        ))
        .await
        .map_err(E::from)?;
    if entities.row_count != 2 {
        return Err(E::from(PgError::new(RELATION_SCOPE_ERROR)));
    }

    if let Some(observation_id) = input.source_observation_id.as_deref() {
        let replay = session
            .query(PgStatement::with_params(
                SQL_RELATION_REPLAY,
                vec![
                    PgValue::text(observation_id),
                    PgValue::text(input.source_entity_id.as_str()),
                    PgValue::text(input.target_entity_id.as_str()),
                    PgValue::text(input.relation_type.as_str()),
                ],
            ))
            .await
            .map_err(E::from)?;
        if let Some(row) = replay.first() {
            return Ok(relation_from_row(row));
        }
    }

    let now = input
        .known_from
        .clone()
        .unwrap_or_else(|| chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
    let superseded = session
        .query(PgStatement::with_params(
            SQL_SUPERSEDE_RELATIONS,
            vec![
                PgValue::text(input.user_id.as_str()),
                PgValue::text(input.persona_id.as_str()),
                PgValue::text(input.workspace_id.as_str()),
                PgValue::text(input.source_entity_id.as_str()),
                PgValue::text(now.as_str()),
                PgValue::text(input.relation_type.as_str()),
            ],
        ))
        .await
        .map_err(E::from)?;
    let result = session
        .query(PgStatement::with_params(
            SQL_INSERT_RELATION,
            vec![
                PgValue::text(input.user_id.as_str()),
                PgValue::text(input.persona_id.as_str()),
                PgValue::text(input.workspace_id.as_str()),
                PgValue::text(input.source_entity_id.as_str()),
                PgValue::text(input.target_entity_id.as_str()),
                PgValue::text(input.relation_type.as_str()),
                PgValue::float(input.confidence.unwrap_or(0.8)),
                PgValue::text(input.valid_from.as_deref().unwrap_or(&now)),
                PgValue::nullable_text(input.valid_to.clone()),
                PgValue::text(now),
                PgValue::nullable_text(superseded.first().map(|row| row_text(row, "id"))),
                PgValue::nullable_text(input.source_observation_id.clone()),
            ],
        ))
        .await
        .map_err(E::from)?;
    first_row(result, MISSING_RELATION_ROW).map(|row| relation_from_row(&row))
}

/// `listActiveRelations` — `entityRepository.ts:226-244`.
pub async fn list_active_relations<E: From<PgError> + Send + 'static>(
    executor: &dyn PgExecutor,
    scope: Option<&WorldModelScope>,
    user_id: &str,
    persona_id: &str,
    workspace_id: &str,
) -> Result<Vec<EntityRelationRecord>, E> {
    let result = ambient_query::<E>(
        executor,
        scope,
        PgStatement::with_params(
            SQL_ACTIVE_RELATIONS,
            vec![
                PgValue::text(user_id),
                PgValue::text(persona_id),
                PgValue::text(workspace_id),
            ],
        ),
    )
    .await?;
    Ok(result.rows.iter().map(relation_from_row).collect())
}

/// `listRelationHistory` — `entityRepository.ts:246-267`.
#[allow(clippy::too_many_arguments)]
pub async fn list_relation_history<E: From<PgError> + Send + 'static>(
    executor: &dyn PgExecutor,
    scope: Option<&WorldModelScope>,
    user_id: &str,
    persona_id: &str,
    workspace_id: &str,
    source_entity_id: &str,
    target_entity_id: &str,
    relation_type: &str,
) -> Result<Vec<EntityRelationRecord>, E> {
    let result = ambient_query::<E>(
        executor,
        scope,
        PgStatement::with_params(
            SQL_RELATION_HISTORY,
            vec![
                PgValue::text(user_id),
                PgValue::text(persona_id),
                PgValue::text(workspace_id),
                PgValue::text(source_entity_id),
                PgValue::text(target_entity_id),
                PgValue::text(relation_type),
            ],
        ),
    )
    .await?;
    Ok(result.rows.iter().map(relation_from_row).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world_model::db::drive_sync;
    use crate::world_model::db::testing::{Recorded, RecordingExecutor};
    use crate::world_model::db::{SQL_BEGIN, SQL_COMMIT, SQL_SET_SCOPE};
    use serde_json::json;

    fn row(value: Value) -> PgRow {
        value.as_object().expect("row").clone()
    }

    fn entity_row() -> PgRow {
        row(json!({
            "id":"e1", "user_id":"u1", "persona_id":"p1", "workspace_id":"",
            "canonical_name":"Kai", "category":"person", "owner":"shared",
            "properties":{"source":"chat"}, "created_at":"2026-10-10T10:00:00.000Z"
        }))
    }

    fn relation_row() -> PgRow {
        row(json!({
            "id":"r1", "user_id":"u1", "persona_id":"p1", "workspace_id":"",
            "source_entity_id":"e1", "target_entity_id":"e2", "relation_type":"knows",
            "direction":"outgoing", "confidence":0.8, "valid_from":"2026-10-10T10:00:00.000Z",
            "valid_to":null, "known_from":"2026-10-10T10:00:00.000Z", "known_to":null,
            "supersedes_relation_id":null, "source_observation_id":"o1"
        }))
    }

    fn scope() -> WorldModelScope {
        WorldModelScope::new("u1", "p1", None)
    }

    fn relation_input() -> EntityRelationInput {
        EntityRelationInput {
            user_id: "u1".into(),
            persona_id: "p1".into(),
            workspace_id: String::new(),
            source_entity_id: "e1".into(),
            target_entity_id: "e2".into(),
            relation_type: "knows".into(),
            confidence: None,
            valid_from: None,
            valid_to: None,
            known_from: Some("2026-10-10T10:00:00.000Z".into()),
            source_observation_id: Some("o1".into()),
        }
    }

    #[test]
    fn entity_upsert_maps_the_row_and_serializes_soft_defaults() {
        let executor =
            RecordingExecutor::new(vec![Ok(PgQueryResult::from_rows(vec![entity_row()]))]);
        let entity = drive_sync(upsert_entity::<PgError>(
            &executor,
            None,
            &EntityInput {
                user_id: "u1".into(),
                persona_id: "p1".into(),
                workspace_id: String::new(),
                canonical_name: "Kai".into(),
                category: "person".into(),
                owner: None,
                properties: None,
            },
        ))
        .expect("bridge")
        .expect("entity");
        assert_eq!(entity.id, "e1");
        assert_eq!(entity.properties["source"], "chat");
        match &executor.calls()[0] {
            Recorded::Statement(statement) => assert_eq!(
                statement.params,
                vec![
                    PgValue::text("u1"),
                    PgValue::text("p1"),
                    PgValue::text(""),
                    PgValue::text("Kai"),
                    PgValue::text("person"),
                    PgValue::text("shared"),
                    PgValue::text("{}"),
                ]
            ),
            other => panic!("expected upsert, got {other:?}"),
        }
    }

    #[test]
    fn relation_replay_is_checked_after_scope_validation_inside_one_transaction() {
        let executor = RecordingExecutor::new(vec![
            Ok(PgQueryResult::from_rows(vec![
                row(json!({"id":"e1"})),
                row(json!({"id":"e2"})),
            ])),
            Ok(PgQueryResult::from_rows(vec![relation_row()])),
        ]);
        let relation = drive_sync(insert_relation::<PgError>(
            &executor,
            Some(&scope()),
            &relation_input(),
        ))
        .expect("bridge")
        .expect("relation");
        assert_eq!(relation.id, "r1");
        let calls = executor.calls();
        assert_eq!(calls[0].sql(), SQL_BEGIN);
        assert_eq!(calls[1].sql(), SQL_SET_SCOPE);
        assert_eq!(calls[2].sql(), SQL_VALIDATE_RELATION_ENTITIES);
        assert_eq!(calls[3].sql(), SQL_RELATION_REPLAY);
        assert_eq!(calls[4].sql(), SQL_COMMIT);
        assert_eq!(calls.last(), Some(&Recorded::Release));
    }

    #[test]
    fn relation_scope_mismatch_rolls_back_without_writing() {
        let executor = RecordingExecutor::new(vec![Ok(PgQueryResult::from_rows(vec![row(
            json!({"id":"e1"}),
        )]))]);
        let error = drive_sync(insert_relation::<PgError>(
            &executor,
            Some(&scope()),
            &relation_input(),
        ))
        .expect("bridge")
        .expect_err("scope mismatch");
        assert_eq!(error.message, RELATION_SCOPE_ERROR);
        let calls = executor.calls();
        assert_eq!(
            calls[calls.len() - 2].sql(),
            crate::world_model::db::SQL_ROLLBACK
        );
        assert_eq!(calls.last(), Some(&Recorded::Release));
    }
}
