//! Port of `src/server/world-model/services/entityService.ts:1-166`.

use serde_json::{json, Map};

use crate::world_model::db::{PgError, PgExecutor, PgStatement, PgValue};
use crate::world_model::projector::idempotency::{stable_dedup_key, IdempotencyParts};
use crate::world_model::repositories::entity_repository::{
    upsert_entity, EntityInput, EntityRecord,
};
use crate::world_model::repositories::prospective_repository::insert_open_loop;
use crate::world_model::repositories::{ambient_query, row_text};
use crate::world_model::scope::WorldModelScope;
use crate::world_model::types::{OpenLoopInput, OpenLoopType};

pub const SQL_RESOLVE_ENTITY: &str = "SELECT id, canonical_name, category
     FROM world_model_entities
     WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3
       AND (
         LOWER(canonical_name) = LOWER($4)
         OR EXISTS (
           SELECT 1
           FROM jsonb_array_elements_text(
             CASE WHEN jsonb_typeof(properties->'aliases') = 'array'
               THEN properties->'aliases' ELSE '[]'::jsonb END
           ) AS alias
           WHERE LOWER(alias) = LOWER($4)
         )
       )
     ORDER BY canonical_name ASC
     LIMIT 10";

#[derive(Debug, Clone, PartialEq)]
pub struct ResolveEntityInput {
    pub scope: WorldModelScope,
    pub name: String,
    pub category: Option<String>,
    pub aliases: Vec<String>,
    pub source_message_seq: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolveEntityResult {
    pub entity_id: Option<String>,
    pub resolved: bool,
    pub ambiguous: bool,
    pub candidates: Vec<String>,
    pub created_open_loop: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Candidate {
    id: String,
    canonical_name: String,
    category: String,
}

pub async fn resolve_entity(
    executor: &dyn PgExecutor,
    input: &ResolveEntityInput,
) -> Result<ResolveEntityResult, PgError> {
    let workspace_id = input.scope.parts().workspace_id;
    let result = ambient_query::<PgError>(
        executor,
        Some(&input.scope),
        PgStatement::with_params(
            SQL_RESOLVE_ENTITY,
            vec![
                PgValue::text(input.scope.user_id.as_str()),
                PgValue::text(input.scope.persona_id.as_str()),
                PgValue::text(workspace_id),
                PgValue::text(input.name.as_str()),
            ],
        ),
    )
    .await?;
    let candidates = result
        .rows
        .iter()
        .map(|row| Candidate {
            id: row_text(row, "id"),
            canonical_name: row_text(row, "canonical_name"),
            category: row_text(row, "category"),
        })
        .collect::<Vec<_>>();
    match candidates.as_slice() {
        [candidate] => Ok(ResolveEntityResult {
            entity_id: Some(candidate.id.clone()),
            resolved: true,
            ambiguous: false,
            candidates: vec![candidate.canonical_name.clone()],
            created_open_loop: false,
        }),
        [] => {
            if let Some(category) = &input.category {
                let entity = upsert_entity::<PgError>(
                    executor,
                    Some(&input.scope),
                    &EntityInput {
                        user_id: input.scope.user_id.clone(),
                        persona_id: input.scope.persona_id.clone(),
                        workspace_id: input.scope.workspace_id.clone().unwrap_or_default(),
                        canonical_name: input.name.clone(),
                        category: category.clone(),
                        owner: Some("shared".into()),
                        properties: Some(Map::new()),
                    },
                )
                .await?;
                Ok(resolved_created(entity))
            } else {
                Ok(ResolveEntityResult {
                    entity_id: None,
                    resolved: false,
                    ambiguous: false,
                    candidates: Vec::new(),
                    created_open_loop: false,
                })
            }
        }
        _ => {
            let loop_key = stable_dedup_key(
                &IdempotencyParts {
                    scope: &input.scope,
                    source_message_seq: input.source_message_seq.unwrap_or(0),
                    kind: "entity_disambiguation",
                    content: &input.name,
                },
                "clarification",
            );
            let categories = candidates
                .iter()
                .map(|candidate| candidate.category.as_str())
                .collect::<Vec<_>>()
                .join(", ");
            insert_open_loop::<PgError>(
                executor,
                Some(&input.scope),
                &OpenLoopInput {
                    user_id: input.scope.user_id.clone(),
                    persona_id: input.scope.persona_id.clone(),
                    workspace_id: input.scope.workspace_id.clone(),
                    loop_type: OpenLoopType::Clarification,
                    subject_id: None,
                    question: Some(format!(
                        "Welche \"{}\" meinst du? ({categories})",
                        input.name
                    )),
                    missing_information: None,
                    importance: None,
                    trigger_at: None,
                    do_not_ask_before: None,
                    deduplication_key: loop_key,
                    max_attempts: None,
                },
            )
            .await?;
            Ok(ResolveEntityResult {
                entity_id: None,
                resolved: false,
                ambiguous: true,
                candidates: candidates
                    .into_iter()
                    .map(|candidate| candidate.canonical_name)
                    .collect(),
                created_open_loop: true,
            })
        }
    }
}

pub async fn create_entity_with_aliases(
    executor: &dyn PgExecutor,
    scope: &WorldModelScope,
    canonical_name: &str,
    category: &str,
    owner: &str,
    aliases: &[String],
) -> Result<String, PgError> {
    let properties = Map::from_iter([("aliases".to_owned(), json!(aliases))]);
    let entity = upsert_entity::<PgError>(
        executor,
        Some(scope),
        &EntityInput {
            user_id: scope.user_id.clone(),
            persona_id: scope.persona_id.clone(),
            workspace_id: scope.workspace_id.clone().unwrap_or_default(),
            canonical_name: canonical_name.to_owned(),
            category: category.to_owned(),
            owner: Some(owner.to_owned()),
            properties: Some(properties),
        },
    )
    .await?;
    Ok(entity.id)
}

fn resolved_created(entity: EntityRecord) -> ResolveEntityResult {
    ResolveEntityResult {
        entity_id: Some(entity.id),
        resolved: true,
        ambiguous: false,
        candidates: vec![entity.canonical_name],
        created_open_loop: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world_model::db::testing::RecordingExecutor;
    use crate::world_model::db::{drive_sync, PgQueryResult};

    #[test]
    fn unresolved_name_without_category_stays_unresolved() {
        let executor = RecordingExecutor::new(vec![Ok(PgQueryResult::empty())]);
        let result = drive_sync(resolve_entity(
            &executor,
            &ResolveEntityInput {
                scope: WorldModelScope::new("u", "p", Some("w".into())),
                name: "Mira".into(),
                category: None,
                aliases: Vec::new(),
                source_message_seq: None,
            },
        ))
        .expect("async bridge")
        .expect("resolve");
        assert!(!result.resolved);
        assert!(!result.ambiguous);
        assert!(result.candidates.is_empty());
        assert!(!result.created_open_loop);
    }
}
