//! Port of `src/server/world-model/services/observationService.ts:1-83`.

use std::sync::Arc;

use crate::world_model::config::WorldModelConfig;
use crate::world_model::db::{
    run_scoped, BoxFuture, PgError, PgExecutor, PgQueryResult, PgSession, PgStatement,
};
use crate::world_model::repositories::normalized_scope;
use crate::world_model::repositories::observation_repository::{
    insert_observation_with_result, ObservationInsertResult,
};
use crate::world_model::repositories::outbox_repository::enqueue_outbox_event;
use crate::world_model::scope::{scope_key, WorldModelScope};
use crate::world_model::types::{ObservationInput, OutboxEventInput};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq)]
pub struct RecordObservationResult {
    pub observation: crate::world_model::types::Observation,
    pub created: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorldModelWriteHealth {
    Healthy,
    Degraded,
    Blocked,
}

pub async fn record_observation(
    executor: &dyn PgExecutor,
    input: ObservationInput,
    scope: Option<&WorldModelScope>,
    config: &WorldModelConfig,
) -> Result<RecordObservationResult, PgError> {
    if scope.is_some_and(|scope| !same_input_scope(scope, &input)) {
        return Err(PgError::new("[world-model] observation scope mismatch"));
    }
    let effective_scope = scope.cloned().unwrap_or_else(|| {
        WorldModelScope::new(
            input.user_id.clone(),
            input.persona_id.clone(),
            input.workspace_id.clone(),
        )
    });
    if config.mode.is_canonical() && !config.canary_scopes.is_empty() {
        let key = scope_key(&effective_scope);
        if !config.canary_scopes.contains(&key) {
            return Err(PgError::new(format!(
                "[world-model] canonical canary scope denied for {key}; add the scope to WORLD_MODEL_CANARY_SCOPES before writing"
            )));
        }
    }

    let transaction_scope = normalized_scope(&effective_scope);
    let config = config.clone();
    run_scoped(
        executor,
        Some(&transaction_scope),
        Box::new(move |session| {
            Box::pin(async move {
                let transaction_executor = SessionExecutor(Arc::clone(&session));
                let inserted =
                    insert_observation_with_result::<PgError>(&transaction_executor, None, &input)
                        .await?;
                if inserted.created
                    && (config.graphiti_shadow_enabled || config.graphiti_backend_enabled)
                {
                    enqueue_observation_event(&transaction_executor, &input, &inserted).await?;
                }
                Ok(RecordObservationResult {
                    observation: inserted.observation,
                    created: inserted.created,
                })
            })
        }),
    )
    .await
}

pub fn derive_write_health(write_succeeded: bool, mode: &str) -> WorldModelWriteHealth {
    if write_succeeded {
        WorldModelWriteHealth::Healthy
    } else if mode == "canonical" {
        WorldModelWriteHealth::Blocked
    } else {
        WorldModelWriteHealth::Degraded
    }
}

fn same_input_scope(scope: &WorldModelScope, input: &ObservationInput) -> bool {
    scope.user_id == input.user_id
        && scope.persona_id == input.persona_id
        && scope.workspace_id.as_deref().unwrap_or("")
            == input.workspace_id.as_deref().unwrap_or("")
}

async fn enqueue_observation_event(
    executor: &dyn PgExecutor,
    input: &ObservationInput,
    inserted: &ObservationInsertResult,
) -> Result<(), PgError> {
    let mut payload = input.payload.clone();
    payload.insert("userId".into(), Value::String(input.user_id.clone()));
    payload.insert("personaId".into(), Value::String(input.persona_id.clone()));
    payload.insert(
        "workspaceId".into(),
        Value::String(input.workspace_id.clone().unwrap_or_default()),
    );
    payload.insert(
        "sourceType".into(),
        serde_json::to_value(input.source_type).unwrap_or(Value::Null),
    );
    payload.insert("sourceId".into(), Value::String(input.source_id.clone()));
    enqueue_outbox_event::<PgError>(
        executor,
        None,
        &OutboxEventInput {
            event_type: "world.observation.created".into(),
            aggregate_type: "observation".into(),
            aggregate_id: inserted.observation.id.clone(),
            payload,
            idempotency_key: None,
            correlation_id: None,
            user_id: None,
            persona_id: None,
            workspace_id: None,
        },
    )
    .await?;
    Ok(())
}

struct SessionExecutor(Arc<dyn PgSession>);

impl PgExecutor for SessionExecutor {
    fn connect<'a>(&'a self) -> BoxFuture<'a, Result<Arc<dyn PgSession>, PgError>> {
        Box::pin(async { Err(PgError::new("[world-model] nested transaction")) })
    }

    fn query<'a>(
        &'a self,
        statement: PgStatement,
    ) -> BoxFuture<'a, Result<PgQueryResult, PgError>> {
        self.0.query(statement)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world_model::mode::WorldModelMode;

    #[test]
    fn write_health_distinguishes_canonical_failure() {
        assert_eq!(
            derive_write_health(false, WorldModelMode::Canonical.as_str()),
            WorldModelWriteHealth::Blocked
        );
        assert_eq!(
            derive_write_health(false, WorldModelMode::Required.as_str()),
            WorldModelWriteHealth::Degraded
        );
        assert_eq!(
            derive_write_health(true, WorldModelMode::Canonical.as_str()),
            WorldModelWriteHealth::Healthy
        );
    }

    #[test]
    fn scope_comparison_normalizes_absent_workspace_to_empty() {
        let scope = WorldModelScope::new("u", "p", None);
        let input = ObservationInput {
            user_id: "u".into(),
            persona_id: "p".into(),
            workspace_id: Some(String::new()),
            source_type: crate::world_model::types::ObservationSourceType::Manual,
            source_id: "source".into(),
            occurred_at: "2026-10-11T10:00:00.000Z".into(),
            payload: Default::default(),
            source_authority: None,
        };
        assert!(same_input_scope(&scope, &input));
    }
}
