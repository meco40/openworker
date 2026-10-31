//! Production adapter from the S7 ingestion port to the S6 World Model.

use std::sync::Arc;

use serde_json::{Map, Value};

use crate::knowledge::extractor::KnowledgeExtractionResult;
use crate::knowledge::ingestion::world_model_port::{
    CompletedTaskEvidence, ObservationRecord, ProjectWindowRequest, ProjectWindowResult,
    ProjectionPendingInput, WorldModelCheckpointInput, WorldModelConfigView, WorldModelPort,
    WorldModelPortError, WorldModelProjection, WorldModelScope,
};
use crate::world_model::config::{get_world_model_config, WorldModelConfig};
use crate::world_model::db::{PgError, PgExecutor};
use crate::world_model::mem0_policy::is_mem0_factual_write_blocked;
use crate::world_model::projector::normalize_extraction::{
    normalize_extraction, ExtractionEntity, ExtractionEvent, ExtractionRelation,
    KnowledgeExtraction, NormalizeExtractionInput,
};
use crate::world_model::projector::project_window::{
    project_window, CompletedTaskEvidence as PgCompletedTaskEvidence, ProjectWindowInput,
};
use crate::world_model::projector::types::WorldModelProjection as PgWorldModelProjection;
use crate::world_model::repositories::ingestion_checkpoint_repository::IngestionCheckpointInput;
use crate::world_model::repositories::observation_repository::ObservationScope;
use crate::world_model::repositories::projection_pending_repository;
use crate::world_model::scope::WorldModelScope as PgWorldModelScope;
use crate::world_model::services::prospective_engine::match_standing_intents;
use crate::world_model::services::standing_intent_compiler::{
    process_incoming_standing_intents, CompileStandingIntentInput,
};
use crate::world_model::types::{ObservationInput, ObservationSourceType};

/// Runs the actual S6 repositories and projector used by the canonical World Model.
#[derive(Clone)]
pub struct PgWorldModelPort {
    executor: Arc<dyn PgExecutor>,
}

impl PgWorldModelPort {
    pub fn new(executor: Arc<dyn PgExecutor>) -> Self {
        Self { executor }
    }
}

fn pg_scope(scope: &WorldModelScope) -> PgWorldModelScope {
    PgWorldModelScope::new(
        scope.user_id.clone(),
        scope.persona_id.clone(),
        Some(scope.workspace_id.clone()),
    )
}

fn world_model_extraction(result: &KnowledgeExtractionResult) -> KnowledgeExtraction {
    KnowledgeExtraction {
        facts: result.facts.clone(),
        events: result
            .events
            .iter()
            .map(|event| ExtractionEvent {
                event_type: event.event_type.clone(),
                subject: event.subject.clone(),
                start_date: event.start_date.clone(),
                end_date: event.end_date.clone(),
                source_seq: event.source_seq.clone(),
                confirmation_signals: event.confirmation_signals.clone(),
                is_confirmation: event.is_confirmation,
            })
            .collect(),
        entities: result
            .entities
            .iter()
            .map(|entity| ExtractionEntity {
                name: entity.name.clone(),
                category: entity.category.as_str().to_string(),
                owner: entity.owner.as_str().to_string(),
                aliases: Some(entity.aliases.clone()),
                relations: entity
                    .relations
                    .iter()
                    .map(|relation| ExtractionRelation {
                        target_name: relation.target_name.clone(),
                        relation_type: relation.relation_type.clone(),
                    })
                    .collect(),
                source_seq: entity.source_seq.clone(),
            })
            .collect(),
        action_items: result.meeting_ledger.action_items.clone(),
        open_points: result.meeting_ledger.open_points.clone(),
        confidence: result.meeting_ledger.confidence,
        episode: Some(result.episode.clone()),
    }
}

fn observation_payload(value: Value) -> Result<Map<String, Value>, WorldModelPortError> {
    value.as_object().cloned().ok_or_else(|| {
        WorldModelPortError("knowledge observation payload must be a JSON object".into())
    })
}

fn config_view(config: &WorldModelConfig) -> WorldModelConfigView {
    WorldModelConfigView {
        enabled: config.enabled,
        e2e_enabled: config.e2e_enabled,
        required: config.mode.is_required(),
    }
}

impl WorldModelPort for PgWorldModelPort {
    fn config(&self) -> WorldModelConfigView {
        config_view(&get_world_model_config())
    }

    fn is_mem0_factual_write_blocked(&self) -> bool {
        is_mem0_factual_write_blocked(&get_world_model_config())
    }

    fn normalize_extraction(
        &self,
        result: &KnowledgeExtractionResult,
        scope: &WorldModelScope,
    ) -> Result<WorldModelProjection, WorldModelPortError> {
        let pg_scope = pg_scope(scope);
        let projection = normalize_extraction(&NormalizeExtractionInput {
            result: world_model_extraction(result),
            workspace_id: pg_scope.workspace_id.unwrap_or_default(),
            user_id: pg_scope.user_id,
            persona_id: pg_scope.persona_id,
        });
        let tasks = projection
            .tasks
            .iter()
            .map(
                |task| crate::knowledge::ingestion::world_model_port::ProjectedTask {
                    title: task.title.clone(),
                },
            )
            .collect();
        let payload = serde_json::to_value(projection)
            .map_err(|error| WorldModelPortError(error.to_string()))?;
        Ok(WorldModelProjection { tasks, payload })
    }

    async fn project_window(
        &self,
        request: ProjectWindowRequest<'_>,
    ) -> Result<ProjectWindowResult, WorldModelPortError> {
        let ProjectWindowRequest {
            scope,
            projection: knowledge_projection,
            observation,
            extraction,
            completed_task_evidence,
        } = request;
        let projection: PgWorldModelProjection =
            serde_json::from_value(knowledge_projection.payload)
                .map_err(|error| WorldModelPortError(error.to_string()))?;
        let source_type = match observation.source_type.as_str() {
            "automation" => ObservationSourceType::Automation,
            _ => {
                return Err(WorldModelPortError(format!(
                    "unsupported knowledge observation source type: {}",
                    observation.source_type
                )))
            }
        };
        let output = project_window(
            self.executor.as_ref(),
            ProjectWindowInput {
                scope: pg_scope(&scope),
                projection,
                observation: ObservationInput {
                    user_id: observation.user_id,
                    persona_id: observation.persona_id,
                    workspace_id: Some(observation.workspace_id),
                    source_type,
                    source_id: observation.source_id,
                    occurred_at: observation.occurred_at,
                    payload: observation_payload(observation.payload)?,
                    source_authority: Some(observation.source_authority),
                },
                extraction: Some(world_model_extraction(extraction)),
                completed_task_evidence: completed_task_evidence
                    .into_iter()
                    .map(|evidence: CompletedTaskEvidence| PgCompletedTaskEvidence {
                        title: evidence.title,
                        message_seq: evidence.message_seq,
                        evidence_text: evidence.evidence_text,
                        confidence: evidence.confidence,
                    })
                    .collect(),
            },
        )
        .await
        .map_err(|error| WorldModelPortError(error.to_string()))?;
        Ok(ProjectWindowResult {
            observation_id: output.observation_id,
        })
    }

    async fn enqueue_projection_pending(
        &self,
        input: ProjectionPendingInput,
    ) -> Result<(), WorldModelPortError> {
        let payload = observation_payload(input.payload)?;
        projection_pending_repository::enqueue_projection_pending::<PgError>(
            self.executor.as_ref(),
            &projection_pending_repository::ProjectionPendingInput {
                scope: pg_scope(&input.scope),
                projection_type: input.projection_type,
                source_observation_id: input.source_observation_id,
                source_window_id: input.source_window_id,
                payload: Some(payload),
                error_message: Some(input.error_message),
            },
        )
        .await
        .map(|_| ())
        .map_err(|error| WorldModelPortError(error.to_string()))
    }

    async fn process_incoming_standing_intents(
        &self,
        scope: &WorldModelScope,
        text: &str,
    ) -> Result<(), WorldModelPortError> {
        let scope = pg_scope(scope);
        process_incoming_standing_intents(
            self.executor.as_ref(),
            Some(&scope),
            &get_world_model_config(),
            &CompileStandingIntentInput {
                user_id: scope.user_id.clone(),
                persona_id: scope.persona_id.clone(),
                workspace_id: Some(scope.workspace_id.clone().unwrap_or_default()),
                statement: text.to_string(),
            },
        )
        .await;
        Ok(())
    }

    async fn get_observation_by_id(
        &self,
        observation_id: &str,
        scope: &WorldModelScope,
    ) -> Result<Option<ObservationRecord>, WorldModelPortError> {
        let scope = pg_scope(scope);
        crate::world_model::repositories::observation_repository::get_observation_by_id::<PgError>(
            self.executor.as_ref(),
            Some(&scope),
            observation_id,
            Some(&ObservationScope {
                user_id: scope.user_id.clone(),
                persona_id: scope.persona_id.clone(),
                workspace_id: scope.workspace_id.clone(),
            }),
        )
        .await
        .map_err(|error| WorldModelPortError(error.to_string()))
    }

    async fn match_standing_intents(
        &self,
        observation: &ObservationRecord,
    ) -> Result<(), WorldModelPortError> {
        let scope = PgWorldModelScope::new(
            observation.input.user_id.clone(),
            observation.input.persona_id.clone(),
            observation.input.workspace_id.clone(),
        );
        match_standing_intents(self.executor.as_ref(), Some(&scope), observation)
            .await
            .map(|_| ())
            .map_err(|error| WorldModelPortError(error.to_string()))
    }

    async fn upsert_ingestion_checkpoint(
        &self,
        input: WorldModelCheckpointInput,
    ) -> Result<(), WorldModelPortError> {
        let scope = PgWorldModelScope::new(
            input.user_id.clone(),
            input.persona_id.clone(),
            Some(input.workspace_id.clone()),
        );
        crate::world_model::repositories::ingestion_checkpoint_repository::upsert_world_model_ingestion_checkpoint::<PgError>(
            self.executor.as_ref(),
            Some(&scope),
            &IngestionCheckpointInput {
                conversation_id: input.conversation_id,
                user_id: input.user_id,
                persona_id: input.persona_id,
                workspace_id: Some(input.workspace_id),
                last_seq: input.last_seq as f64,
                source_window_id: input.source_window_id,
                committed_observation_id: input.committed_observation_id,
            },
        )
        .await
        .map(|_| ())
        .map_err(|error| WorldModelPortError(error.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::knowledge::extractor::KnowledgeMeetingLedger;
    use crate::world_model::db::testing::{Recorded, RecordingExecutor};
    use crate::world_model::db::{drive_sync, PgQueryResult, SQL_SET_SCOPE};
    use serde_json::json;

    fn extraction() -> KnowledgeExtractionResult {
        KnowledgeExtractionResult {
            facts: vec!["Der Vertrag gilt ab Montag.".into()],
            teaser: "Vertragsstart vereinbart.".into(),
            episode: "Der Vertragsstart wurde festgelegt.".into(),
            meeting_ledger: KnowledgeMeetingLedger {
                topic_key: "vertrag".into(),
                counterpart: Some("Mira".into()),
                participants: vec!["Mira".into()],
                decisions: Vec::new(),
                negotiated_terms: Vec::new(),
                open_points: vec!["SLA-Abnahme".into()],
                action_items: vec!["Mira sendet den Entwurf".into()],
                source_refs: Vec::new(),
                confidence: 0.8,
            },
            events: Vec::new(),
            entities: Vec::new(),
        }
    }

    #[test]
    fn normalization_keeps_the_knowledge_facts_and_tenant_on_world_model_tasks() {
        let executor = Arc::new(RecordingExecutor::new(Vec::new()));
        let port = PgWorldModelPort::new(executor);
        let scope = WorldModelScope {
            user_id: "user-1".into(),
            persona_id: "persona-1".into(),
            workspace_id: "workspace-1".into(),
        };

        let normalized = port
            .normalize_extraction(&extraction(), &scope)
            .expect("normalize");
        let projection: PgWorldModelProjection =
            serde_json::from_value(normalized.payload).expect("projection payload");

        assert_eq!(normalized.tasks.len(), 1);
        assert_eq!(normalized.tasks[0].title, "Mira sendet den Entwurf");
        assert_eq!(
            projection.assertions[0].object_value.as_deref(),
            Some("Der Vertrag gilt ab Montag.")
        );
        assert_eq!(projection.tasks[0].requester, "user-1");
        assert_eq!(projection.tasks[0].assignee, "persona-1");
    }

    #[test]
    fn observation_lookup_returns_the_full_scoped_record_for_intent_matching() {
        let row = json!({
            "id": "observation-1",
            "user_id": "user-1",
            "persona_id": "persona-1",
            "workspace_id": "workspace-1",
            "source_type": "automation",
            "source_id": "conversation-1:1-2",
            "occurred_at": "2026-10-12T03:00:00.000Z",
            "received_at": "2026-10-12T03:00:01.000Z",
            "payload": { "text": "Mira sendet den Entwurf" },
            "source_authority": "persona"
        })
        .as_object()
        .expect("row")
        .clone();
        let executor = Arc::new(RecordingExecutor::new(vec![Ok(PgQueryResult::from_rows(
            vec![row],
        ))]));
        let port = PgWorldModelPort::new(executor.clone());
        let scope = WorldModelScope {
            user_id: "user-1".into(),
            persona_id: "persona-1".into(),
            workspace_id: "workspace-1".into(),
        };

        let observation = drive_sync(port.get_observation_by_id("observation-1", &scope))
            .expect("bridge")
            .expect("lookup")
            .expect("observation");

        assert_eq!(observation.input.user_id, scope.user_id);
        assert_eq!(
            observation.input.workspace_id.as_deref(),
            Some("workspace-1")
        );
        assert_eq!(
            observation.input.payload.get("text"),
            Some(&json!("Mira sendet den Entwurf"))
        );
        let calls = executor.calls();
        match &calls[1] {
            Recorded::Statement(statement) => {
                assert_eq!(statement.sql, SQL_SET_SCOPE);
                assert_eq!(
                    statement.params,
                    vec![
                        crate::world_model::db::PgValue::text("user-1"),
                        crate::world_model::db::PgValue::text("persona-1"),
                        crate::world_model::db::PgValue::text("workspace-1"),
                    ]
                );
            }
            other => panic!("expected tenant scope call, got {other:?}"),
        }
    }
}
