//! Port of `src/server/world-model/projector/projectWindow.ts:1-495`.

use std::sync::Arc;

use crate::world_model::config::get_world_model_config;
use crate::world_model::db::{
    run_scoped, BoxFuture, PgError, PgExecutor, PgQueryResult, PgSession, PgStatement, PgValue,
};
use crate::world_model::projector::idempotency::{stable_dedup_key, IdempotencyParts};
use crate::world_model::projector::normalize_extraction::KnowledgeExtraction;
use crate::world_model::projector::types::{
    ProjectedEvent, ProjectedOpenLoopType, WorldModelProjection,
};
use crate::world_model::repositories::assertion_repository::WorldModelAssertionInput;
use crate::world_model::repositories::entity_repository::{EntityInput, EntityRelationInput};
use crate::world_model::repositories::event_repository;
use crate::world_model::repositories::observation_repository::insert_observation_with_result;
use crate::world_model::repositories::outbox_repository::enqueue_outbox_event;
use crate::world_model::repositories::prospective_repository::{
    get_open_loop_by_key, insert_open_loop, update_open_loop_status,
};
use crate::world_model::repositories::task_repository::{
    insert_task, TaskCompletionInput, WorldModelTaskInput,
};
use crate::world_model::repositories::{normalized_scope, row_text};
use crate::world_model::scope::WorldModelScope;
use crate::world_model::services::event_linker::{
    classify_event_utterance, pick_event_candidate, EventCandidateHit, EventUtteranceKind,
};
use crate::world_model::types::{
    EventInput, EventStatus, EventTransitionInput, Observation, ObservationInput, OpenLoopInput,
    OpenLoopStatus, OpenLoopType, OutboxEventInput, TaskStatus,
};
use serde_json::{json, Map, Value};

/// Single-statement repositories run on the already scoped transaction. Their
/// nested transaction path is kept explicit through the `PgSession` variants.
struct ProjectionExecutor(Arc<dyn PgSession>);

impl PgExecutor for ProjectionExecutor {
    fn connect<'a>(&'a self) -> BoxFuture<'a, Result<Arc<dyn PgSession>, PgError>> {
        Box::pin(async { Err(PgError::new("[world-model] nested projector transaction")) })
    }

    fn query<'a>(
        &'a self,
        statement: PgStatement,
    ) -> BoxFuture<'a, Result<PgQueryResult, PgError>> {
        self.0.query(statement)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct CompletedTaskEvidence {
    pub title: String,
    pub message_seq: i64,
    pub evidence_text: String,
    pub confidence: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ProjectWindowInput {
    pub scope: WorldModelScope,
    pub projection: WorldModelProjection,
    pub observation: ObservationInput,
    pub extraction: Option<KnowledgeExtraction>,
    pub completed_task_evidence: Vec<CompletedTaskEvidence>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ProjectWindowOutput {
    pub observation_id: String,
    pub entities_upserted: usize,
    pub events_created: usize,
    pub open_loops_upserted: usize,
    pub relations_created: usize,
    pub assertions_created: usize,
}

/// `projectWindow(input)` writes one complete projection and its outbox intents atomically.
pub async fn project_window(
    executor: &dyn PgExecutor,
    input: ProjectWindowInput,
) -> Result<ProjectWindowOutput, PgError> {
    let normalized = normalized_scope(&input.scope);
    let graphiti_enabled = {
        let config = get_world_model_config();
        config.graphiti_shadow_enabled || config.graphiti_backend_enabled
    };
    run_scoped(
        executor,
        Some(&normalized),
        Box::new(move |session| {
            Box::pin(async move {
                let query_executor = ProjectionExecutor(Arc::clone(&session));
                project_window_in(&query_executor, session.as_ref(), input, graphiti_enabled).await
            })
        }),
    )
    .await
}

async fn project_window_in(
    executor: &dyn PgExecutor,
    session: &dyn PgSession,
    input: ProjectWindowInput,
    graphiti_enabled: bool,
) -> Result<ProjectWindowOutput, PgError> {
    let ProjectWindowInput {
        scope,
        projection,
        observation,
        extraction,
        completed_task_evidence,
    } = input;
    let workspace_id = scope.workspace_id.clone().unwrap_or_default();
    let observation_result =
        insert_observation_with_result::<PgError>(executor, None, &observation).await?;
    let stored_observation = observation_result.observation;
    let mut output = ProjectWindowOutput {
        observation_id: stored_observation.id.clone(),
        ..ProjectWindowOutput::default()
    };

    if observation_result.created && graphiti_enabled {
        let text = observation_text(&observation.payload);
        enqueue_outbox_event::<PgError>(
            executor,
            None,
            &OutboxEventInput {
                event_type: "world.observation.created".into(),
                aggregate_type: "observation".into(),
                aggregate_id: stored_observation.id.clone(),
                payload: [
                    ("userId".into(), json!(scope.user_id)),
                    ("personaId".into(), json!(scope.persona_id)),
                    ("workspaceId".into(), json!(workspace_id)),
                    ("text".into(), json!(text)),
                ]
                .into_iter()
                .collect(),
                idempotency_key: None,
                correlation_id: None,
                user_id: Some(scope.user_id.clone()),
                persona_id: Some(scope.persona_id.clone()),
                workspace_id: Some(workspace_id.clone()),
            },
        )
        .await?;
    }

    for entity in &projection.entities {
        let key = stable_dedup_key(
            &IdempotencyParts {
                scope: &scope,
                source_message_seq: entity.source_message_seq,
                kind: "entity",
                content: &entity.canonical_name,
            },
            &entity.owner,
        );
        let properties = Map::from_iter([
            ("dedupKey".into(), json!(key)),
            ("aliases".into(), json!(entity.aliases)),
        ]);
        crate::world_model::repositories::entity_repository::upsert_entity::<PgError>(
            executor,
            None,
            &EntityInput {
                user_id: scope.user_id.clone(),
                persona_id: scope.persona_id.clone(),
                workspace_id: workspace_id.clone(),
                canonical_name: entity.canonical_name.clone(),
                category: entity.category.clone(),
                owner: Some(entity.owner.clone()),
                properties: Some(properties),
            },
        )
        .await?;
        output.entities_upserted += 1;
    }

    for relation in &projection.relations {
        let source = resolve_entity(
            executor,
            &scope,
            &relation.source_entity,
            None,
            relation.source_message_seq,
        )
        .await?;
        let target = resolve_entity(
            executor,
            &scope,
            &relation.target_entity,
            None,
            relation.source_message_seq,
        )
        .await?;
        let (Some(source_id), Some(target_id)) = (source.id, target.id) else {
            continue;
        };
        if source.ambiguous || target.ambiguous {
            continue;
        }
        crate::world_model::repositories::entity_repository::insert_relation_in::<PgError>(
            session,
            &EntityRelationInput {
                user_id: scope.user_id.clone(),
                persona_id: scope.persona_id.clone(),
                workspace_id: workspace_id.clone(),
                source_entity_id: source_id,
                target_entity_id: target_id,
                relation_type: relation.relation_type.clone(),
                confidence: Some(relation.confidence),
                valid_from: None,
                valid_to: None,
                known_from: None,
                source_observation_id: Some(stored_observation.id.clone()),
            },
        )
        .await?;
        output.relations_created += 1;
    }

    for assertion in &projection.assertions {
        let subject = resolve_entity(
            executor,
            &scope,
            &assertion.subject,
            Some("person"),
            assertion.source_message_seq,
        )
        .await?;
        if subject.ambiguous {
            continue;
        }
        let subject_id = if let Some(id) = subject.id {
            id
        } else {
            let entity =
                crate::world_model::repositories::entity_repository::upsert_entity::<PgError>(
                    executor,
                    None,
                    &EntityInput {
                        user_id: scope.user_id.clone(),
                        persona_id: scope.persona_id.clone(),
                        workspace_id: workspace_id.clone(),
                        canonical_name: assertion.subject.clone(),
                        category: "person".into(),
                        owner: Some("persona".into()),
                        properties: None,
                    },
                )
                .await?;
            entity.id
        };
        crate::world_model::repositories::assertion_repository::insert_assertion::<PgError>(
            executor,
            None,
            &WorldModelAssertionInput {
                user_id: scope.user_id.clone(),
                persona_id: scope.persona_id.clone(),
                workspace_id: workspace_id.clone(),
                subject_id,
                predicate: assertion.predicate.clone(),
                object_value: assertion.object_value.clone(),
                object_id: None,
                polarity: Some(1),
                modality: Some(assertion.modality),
                confidence: Some(assertion.confidence),
                source_observation_id: Some(stored_observation.id.clone()),
            },
            None,
        )
        .await?;
        output.assertions_created += 1;
    }

    for event in &projection.events {
        project_event(
            executor,
            &scope,
            event,
            &stored_observation,
            &projection,
            extraction.as_ref(),
            &mut output,
        )
        .await?;
    }

    for loop_item in &projection.open_loops {
        let key = stable_dedup_key(
            &IdempotencyParts {
                scope: &scope,
                source_message_seq: loop_item.source_message_seq,
                kind: "open_loop",
                content: &loop_item.deduplication_key,
            },
            loop_type_text(projected_loop_type(loop_item.loop_type)),
        );
        insert_open_loop::<PgError>(
            executor,
            None,
            &OpenLoopInput {
                user_id: scope.user_id.clone(),
                persona_id: scope.persona_id.clone(),
                workspace_id: Some(workspace_id.clone()),
                loop_type: projected_loop_type(loop_item.loop_type),
                subject_id: None,
                question: loop_item.question.clone(),
                missing_information: None,
                importance: None,
                trigger_at: None,
                do_not_ask_before: None,
                deduplication_key: key,
                max_attempts: None,
            },
        )
        .await?;
        output.open_loops_upserted += 1;
    }

    for task in &projection.tasks {
        let key = stable_dedup_key(
            &IdempotencyParts {
                scope: &scope,
                source_message_seq: task.source_message_seq,
                kind: "task",
                content: &task.title,
            },
            &task.assignee,
        );
        let stored = insert_task::<PgError>(
            executor,
            None,
            &WorldModelTaskInput {
                user_id: scope.user_id.clone(),
                persona_id: scope.persona_id.clone(),
                workspace_id: workspace_id.clone(),
                title: task.title.clone(),
                description: None,
                requester: Some(task.requester.clone()),
                assignee: Some(task.assignee.clone()),
                external_task_id: None,
                origin: None,
                status: Some(TaskStatus::Proposed),
                due_at: None,
                idempotency_key: Some(key),
                source_observation_id: Some(stored_observation.id.clone()),
            },
        )
        .await?;
        if let Some(evidence) = completed_task_evidence
            .iter()
            .find(|item| item.title.trim().eq_ignore_ascii_case(task.title.trim()))
        {
            let evidence_map = Map::from_iter([
                ("messageSeq".into(), json!(evidence.message_seq)),
                ("text".into(), json!(evidence.evidence_text)),
                ("confidence".into(), json!(evidence.confidence)),
            ]);
            crate::world_model::repositories::task_repository::complete_task_with_evidence_in::<
                PgError,
            >(
                session,
                &stored.id,
                &TaskCompletionInput {
                    source_observation_id: stored_observation.id.clone(),
                    evidence: evidence_map,
                    result: Some(evidence.evidence_text.clone()),
                },
            )
            .await?;
        }
    }
    Ok(output)
}

struct EntityResolution {
    id: Option<String>,
    ambiguous: bool,
}

async fn resolve_entity(
    executor: &dyn PgExecutor,
    scope: &WorldModelScope,
    name: &str,
    category: Option<&str>,
    source_message_seq: i64,
) -> Result<EntityResolution, PgError> {
    let parts = scope.parts();
    let result = executor.query(PgStatement::with_params(
        "SELECT id, canonical_name, category FROM world_model_entities\n     WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3\n       AND (LOWER(canonical_name) = LOWER($4) OR EXISTS (\n         SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(properties->'aliases') = 'array' THEN properties->'aliases' ELSE '[]'::jsonb END) AS alias\n         WHERE LOWER(alias) = LOWER($4)))\n     ORDER BY canonical_name ASC LIMIT 10",
        vec![PgValue::text(parts.user_id), PgValue::text(parts.persona_id), PgValue::text(parts.workspace_id), PgValue::text(name)],
    )).await?;
    match result.rows.as_slice() {
        [row] => Ok(EntityResolution {
            id: Some(row_text(row, "id")),
            ambiguous: false,
        }),
        [] => {
            if let Some(category) = category {
                let entity =
                    crate::world_model::repositories::entity_repository::upsert_entity::<PgError>(
                        executor,
                        None,
                        &EntityInput {
                            user_id: scope.user_id.clone(),
                            persona_id: scope.persona_id.clone(),
                            workspace_id: scope.workspace_id.clone().unwrap_or_default(),
                            canonical_name: name.into(),
                            category: category.into(),
                            owner: Some("shared".into()),
                            properties: None,
                        },
                    )
                    .await?;
                Ok(EntityResolution {
                    id: Some(entity.id),
                    ambiguous: false,
                })
            } else {
                Ok(EntityResolution {
                    id: None,
                    ambiguous: false,
                })
            }
        }
        rows => {
            let candidates = rows
                .iter()
                .map(|row| row_text(row, "category"))
                .collect::<Vec<_>>()
                .join(", ");
            let key = stable_dedup_key(
                &IdempotencyParts {
                    scope,
                    source_message_seq,
                    kind: "entity_disambiguation",
                    content: name,
                },
                "clarification",
            );
            insert_open_loop::<PgError>(
                executor,
                None,
                &OpenLoopInput {
                    user_id: scope.user_id.clone(),
                    persona_id: scope.persona_id.clone(),
                    workspace_id: scope.workspace_id.clone(),
                    loop_type: OpenLoopType::Clarification,
                    subject_id: None,
                    question: Some(format!("Welche \"{name}\" meinst du? ({candidates})")),
                    missing_information: None,
                    importance: None,
                    trigger_at: None,
                    do_not_ask_before: None,
                    deduplication_key: key,
                    max_attempts: None,
                },
            )
            .await?;
            Ok(EntityResolution {
                id: None,
                ambiguous: true,
            })
        }
    }
}

fn projected_loop_type(value: ProjectedOpenLoopType) -> OpenLoopType {
    match value {
        ProjectedOpenLoopType::Clarification => OpenLoopType::Clarification,
        ProjectedOpenLoopType::Confirmation => OpenLoopType::Confirmation,
        ProjectedOpenLoopType::EventOutcome => OpenLoopType::EventOutcome,
        ProjectedOpenLoopType::Dependency => OpenLoopType::Dependency,
        ProjectedOpenLoopType::MissingContext => OpenLoopType::MissingContext,
    }
}

fn loop_type_text(value: OpenLoopType) -> &'static str {
    match value {
        OpenLoopType::Clarification => "clarification",
        OpenLoopType::Confirmation => "confirmation",
        OpenLoopType::EventOutcome => "event_outcome",
        OpenLoopType::Dependency => "dependency",
        OpenLoopType::MissingContext => "missing_context",
        OpenLoopType::PromisedFollowUp => "promised_follow_up",
    }
}

fn observation_text(payload: &Map<String, Value>) -> String {
    payload
        .get("texts")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|message| {
            let content = message.get("content");
            match content {
                None | Some(Value::Null) => None,
                Some(value) => {
                    let text = js_string(value);
                    (!text.is_empty()).then_some(text)
                }
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn js_string(value: &Value) -> String {
    match value {
        Value::String(value) => value.clone(),
        Value::Null => "null".into(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::Array(values) => values
            .iter()
            .map(|value| {
                if value.is_null() {
                    String::new()
                } else {
                    js_string(value)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

fn source_text(
    event: &ProjectedEvent,
    observation: &Observation,
    extraction: Option<&KnowledgeExtraction>,
) -> String {
    if let Some(texts) = observation
        .input
        .payload
        .get("texts")
        .and_then(Value::as_array)
    {
        for message in texts {
            let seq = message
                .get("seq")
                .map(js_string)
                .and_then(|text| text.parse::<f64>().ok())
                .unwrap_or(f64::NAN);
            if seq == event.source_message_seq as f64 {
                if let Some(content) = message
                    .get("content")
                    .and_then(Value::as_str)
                    .filter(|text| !text.is_empty())
                {
                    return content.into();
                }
            }
        }
    }
    if let Some(extraction) = extraction {
        if let Some(extracted) = extraction.events.iter().find(|candidate| {
            candidate.source_seq.first().copied().unwrap_or(0) == event.source_message_seq
                && (candidate.subject == event.title || candidate.event_type == event.event_type)
        }) {
            if !extracted.confirmation_signals.is_empty() {
                return extracted.confirmation_signals.join(" ");
            }
        }
        if let Some(episode) = extraction.episode.as_deref() {
            return episode.into();
        }
    }
    event.title.clone()
}

fn extracted_confirmation(
    event: &ProjectedEvent,
    extraction: Option<&KnowledgeExtraction>,
) -> bool {
    extraction.is_some_and(|extraction| {
        extraction.events.iter().any(|candidate| {
            candidate.source_seq.first().copied().unwrap_or(0) == event.source_message_seq
                && (candidate.subject == event.title || candidate.event_type == event.event_type)
                && candidate.is_confirmation
        })
    })
}

fn titles_match(a: &str, b: &str) -> bool {
    let (a, b) = (a.to_lowercase(), b.to_lowercase());
    a == b || a.contains(&b) || b.contains(&a)
}

fn event_status(value: &Value) -> EventStatus {
    serde_json::from_value(value.clone()).unwrap_or(EventStatus::Unknown)
}

async fn project_event(
    executor: &dyn PgExecutor,
    scope: &WorldModelScope,
    event: &ProjectedEvent,
    observation: &Observation,
    projection: &WorldModelProjection,
    extraction: Option<&KnowledgeExtraction>,
    output: &mut ProjectWindowOutput,
) -> Result<(), PgError> {
    let source = source_text(event, observation, extraction);
    let mut kind = classify_event_utterance(&source);
    if extracted_confirmation(event, extraction) {
        kind = EventUtteranceKind::OutcomeConfirmation;
    }
    let has_replacement = projection.events.iter().any(|candidate| {
        candidate.source_message_seq == event.source_message_seq
            && !titles_match(&candidate.title, &event.title)
    });
    let sentence = source
        .split(['.', '!', '?'])
        .find(|sentence| {
            sentence
                .to_lowercase()
                .contains(&event.title.to_lowercase())
        })
        .unwrap_or(&source)
        .to_lowercase();
    let cancels = [
        "nicht",
        "kein",
        "keine",
        "abgesagt",
        "storniert",
        "fällt aus",
    ]
    .iter()
    .any(|word| sentence.contains(word));
    if kind == EventUtteranceKind::Change && has_replacement && cancels {
        kind = EventUtteranceKind::Cancellation;
    }

    let parts = scope.parts();
    let hits = executor.query(PgStatement::with_params(
        "SELECT id, title, status, scheduled_for, ends_at FROM world_model_events\nWHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3 AND title ILIKE ('%' || $4 || '%')\nORDER BY updated_at DESC LIMIT $5",
        vec![PgValue::text(parts.user_id), PgValue::text(parts.persona_id), PgValue::text(parts.workspace_id), PgValue::text(event.title.trim()), PgValue::int(5)],
    )).await?;
    let candidates = hits
        .rows
        .iter()
        .map(|row| EventCandidateHit {
            event_id: row_text(row, "id"),
            title: row_text(row, "title"),
            confidence: 1.0,
            status: event_status(row.get("status").unwrap_or(&Value::Null)),
        })
        .collect::<Vec<_>>();
    let picked = pick_event_candidate(kind, &candidates);
    let matched = picked.filter(|candidate| {
        matches!(
            candidate.status,
            EventStatus::Planned | EventStatus::Proposed | EventStatus::InProgress
        ) && titles_match(&candidate.title, &event.title)
    });
    let mut replaces_event_id = event.replaces_event_id.clone();

    if let Some(candidate) = matched {
        if kind == EventUtteranceKind::OutcomeConfirmation {
            let to_status = EventStatus::Completed;
            let reason = format!("outcome confirmed as {}", status_literal(to_status));
            apply_event_status(executor, scope, &candidate, to_status, observation, &reason)
                .await?;
            output.events_created += 1;
            return Ok(());
        }
        if kind == EventUtteranceKind::Cancellation {
            apply_event_status(
                executor,
                scope,
                &candidate,
                EventStatus::Cancelled,
                observation,
                "user changed plan",
            )
            .await?;
            output.events_created += 1;
            return Ok(());
        }
        if kind == EventUtteranceKind::Change {
            apply_event_status(
                executor,
                scope,
                &candidate,
                EventStatus::Cancelled,
                observation,
                "user changed plan; replacement follows",
            )
            .await?;
            replaces_event_id = Some(candidate.event_id);
        } else {
            output.events_created += 1;
            return Ok(());
        }
    } else if matches!(
        kind,
        EventUtteranceKind::OutcomeConfirmation | EventUtteranceKind::Cancellation
    ) {
        let kind_label = if kind == EventUtteranceKind::Cancellation {
            "cancellation"
        } else {
            "outcome_confirmation"
        };
        let key = stable_dedup_key(
            &IdempotencyParts {
                scope,
                source_message_seq: event.source_message_seq,
                kind: "open_loop",
                content: &format!("ambiguous:{}:{kind_label}", event.title),
            },
            "clarification",
        );
        insert_open_loop::<PgError>(
            executor,
            None,
            &OpenLoopInput {
                user_id: scope.user_id.clone(),
                persona_id: scope.persona_id.clone(),
                workspace_id: scope.workspace_id.clone(),
                loop_type: OpenLoopType::Clarification,
                subject_id: None,
                question: Some(format!("Welches Event meinst du mit \"{}\"?", event.title)),
                missing_information: None,
                importance: None,
                trigger_at: None,
                do_not_ask_before: None,
                deduplication_key: key,
                max_attempts: None,
            },
        )
        .await?;
        output.open_loops_upserted += 1;
        return Ok(());
    }

    let key = stable_dedup_key(
        &IdempotencyParts {
            scope,
            source_message_seq: event.source_message_seq,
            kind: "event",
            content: &format!(
                "{}:{}:{}",
                event.event_type,
                event.title,
                event.scheduled_for.as_deref().unwrap_or("")
            ),
        },
        status_literal(event.status),
    );
    let stored = event_repository::insert_event::<PgError>(
        executor,
        None,
        &EventInput {
            user_id: scope.user_id.clone(),
            persona_id: scope.persona_id.clone(),
            workspace_id: scope.workspace_id.clone(),
            title: event.title.clone(),
            event_type: event.event_type.clone(),
            subject_entity_id: None,
            counterpart_entity_id: None,
            scheduled_for: event.scheduled_for.clone(),
            ends_at: event.ends_at.clone(),
            status: Some(event.status),
            observed_at: None,
            idempotency_key: Some(key),
            replaces_event_id,
        },
    )
    .await?;
    let transition = executor.query(PgStatement::with_params(
        "SELECT 1 FROM world_model_event_transitions WHERE event_id = $1 AND source_observation_id = $2 AND to_status = $3 LIMIT 1",
        vec![PgValue::text(stored.id.clone()), PgValue::text(observation.id.clone()), PgValue::text(status_literal(event.status))],
    )).await?;
    if transition.first().is_none() {
        event_repository::insert_event_transition::<PgError>(
            executor,
            None,
            &EventTransitionInput {
                event_id: stored.id,
                from_status: None,
                to_status: event.status,
                reason: Some("knowledge projection".into()),
                source_observation_id: Some(observation.id.clone()),
                confidence: Some(if projection.confidence_summary.total > 0 {
                    projection.confidence_summary.confident as f64
                        / projection.confidence_summary.total as f64
                } else {
                    0.5
                }),
                transitioned_at: None,
            },
        )
        .await?;
    }
    output.events_created += 1;
    Ok(())
}

async fn apply_event_status(
    executor: &dyn PgExecutor,
    scope: &WorldModelScope,
    event: &EventCandidateHit,
    to_status: EventStatus,
    observation: &Observation,
    reason: &str,
) -> Result<(), PgError> {
    if event.status == to_status {
        return Ok(());
    }
    let allowed = match event.status {
        EventStatus::Proposed => matches!(to_status, EventStatus::Planned | EventStatus::Cancelled),
        EventStatus::Planned => matches!(
            to_status,
            EventStatus::InProgress
                | EventStatus::Completed
                | EventStatus::NoShow
                | EventStatus::Cancelled
        ),
        EventStatus::InProgress => matches!(
            to_status,
            EventStatus::Completed | EventStatus::NoShow | EventStatus::Cancelled
        ),
        EventStatus::Unknown => matches!(to_status, EventStatus::Planned | EventStatus::Cancelled),
        EventStatus::Completed | EventStatus::Cancelled | EventStatus::NoShow => false,
    };
    if !allowed {
        return Err(PgError::new(format!(
            "[world-model] invalid event transition {} -> {}",
            status_literal(event.status),
            status_literal(to_status)
        )));
    }
    let observation_result =
        insert_observation_with_result::<PgError>(executor, None, &observation.input).await?;
    let stored_observation = observation_result.observation;
    let exists = executor.query(PgStatement::with_params(
        "SELECT 1 FROM world_model_event_transitions WHERE event_id = $1 AND source_observation_id = $2 AND to_status = $3 LIMIT 1",
        vec![PgValue::text(event.event_id.clone()), PgValue::text(stored_observation.id.clone()), PgValue::text(status_literal(to_status))],
    )).await?;
    if exists.first().is_none() {
        event_repository::insert_event_transition::<PgError>(
            executor,
            None,
            &EventTransitionInput {
                event_id: event.event_id.clone(),
                from_status: Some(event.status),
                to_status,
                reason: Some(reason.into()),
                source_observation_id: Some(stored_observation.id.clone()),
                confidence: None,
                transitioned_at: None,
            },
        )
        .await?;
    }
    event_repository::update_event_status::<PgError>(
        executor,
        None,
        &event.event_id,
        to_status,
        Some(&observation.input.occurred_at),
    )
    .await?;
    if matches!(
        to_status,
        EventStatus::Cancelled | EventStatus::Completed | EventStatus::NoShow
    ) {
        let key = format!("event-outcome:{}", event.event_id);
        if let Some(loop_record) = get_open_loop_by_key::<PgError>(
            executor,
            None,
            &scope.user_id,
            &scope.persona_id,
            &key,
            scope.workspace_id.as_deref().unwrap_or(""),
        )
        .await?
        {
            if matches!(
                loop_record.status,
                OpenLoopStatus::Open | OpenLoopStatus::Scheduled | OpenLoopStatus::Asked
            ) {
                let status = if to_status == EventStatus::Cancelled {
                    OpenLoopStatus::Cancelled
                } else {
                    OpenLoopStatus::Resolved
                };
                update_open_loop_status::<PgError>(
                    executor,
                    None,
                    &loop_record.id,
                    status,
                    None,
                    None,
                    None,
                    Some(&format!("event became {}", status_literal(to_status))),
                )
                .await?;
            }
        }
    }
    enqueue_outbox_event::<PgError>(
        executor,
        None,
        &OutboxEventInput {
            event_type: "world.event.status_changed".into(),
            aggregate_type: "event".into(),
            aggregate_id: event.event_id.clone(),
            payload: [
                ("userId".into(), json!(scope.user_id)),
                ("personaId".into(), json!(scope.persona_id)),
                (
                    "workspaceId".into(),
                    json!(scope.workspace_id.as_deref().unwrap_or("")),
                ),
                ("fromStatus".into(), json!(status_literal(event.status))),
                ("toStatus".into(), json!(status_literal(to_status))),
                ("observationId".into(), json!(stored_observation.id)),
            ]
            .into_iter()
            .collect(),
            idempotency_key: None,
            correlation_id: None,
            user_id: Some(scope.user_id.clone()),
            persona_id: Some(scope.persona_id.clone()),
            workspace_id: scope.workspace_id.clone(),
        },
    )
    .await?;
    Ok(())
}

fn status_literal(status: EventStatus) -> &'static str {
    match status {
        EventStatus::Proposed => "proposed",
        EventStatus::Planned => "planned",
        EventStatus::InProgress => "in_progress",
        EventStatus::Completed => "completed",
        EventStatus::Cancelled => "cancelled",
        EventStatus::NoShow => "no_show",
        EventStatus::Unknown => "unknown",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world_model::db::testing::{Recorded, RecordingExecutor};
    use crate::world_model::db::{drive_sync, PgQueryResult, SQL_BEGIN, SQL_COMMIT, SQL_SET_SCOPE};
    use crate::world_model::projector::types::ConfidenceSummary;
    use crate::world_model::types::ObservationSourceType;

    #[test]
    fn empty_projection_commits_observation_inside_rls_scope() {
        let observation_row = json!({
            "id":"o1", "user_id":"u1", "persona_id":"p1", "workspace_id":"w1",
            "source_type":"chat_message", "source_id":"s1", "occurred_at":"2026-10-11T10:00:00.000Z",
            "received_at":"2026-10-11T10:00:01.000Z", "payload":{}, "source_authority":"system"
        }).as_object().unwrap().clone();
        let executor =
            RecordingExecutor::new(vec![Ok(PgQueryResult::from_rows(vec![observation_row]))]);
        let projection = WorldModelProjection {
            assertions: vec![],
            events: vec![],
            entities: vec![],
            relations: vec![],
            open_loops: vec![],
            tasks: vec![],
            confidence_summary: ConfidenceSummary {
                total: 0,
                confident: 0,
            },
        };
        let input = ProjectWindowInput {
            scope: WorldModelScope::new("u1", "p1", Some("w1".into())),
            projection,
            observation: ObservationInput {
                user_id: "u1".into(),
                persona_id: "p1".into(),
                workspace_id: Some("w1".into()),
                source_type: ObservationSourceType::ChatMessage,
                source_id: "s1".into(),
                occurred_at: "2026-10-11T10:00:00.000Z".into(),
                payload: Map::new(),
                source_authority: Some("system".into()),
            },
            extraction: None,
            completed_task_evidence: vec![],
        };
        let result = drive_sync(project_window(&executor, input))
            .unwrap()
            .unwrap();
        assert_eq!(result.observation_id, "o1");
        let calls = executor.calls();
        assert_eq!(calls.first().unwrap().sql(), SQL_BEGIN);
        assert_eq!(calls[1].sql(), SQL_SET_SCOPE);
        assert!(calls[2]
            .sql()
            .starts_with("INSERT INTO world_model_observations"));
        assert_eq!(calls[3].sql(), SQL_COMMIT);
        assert_eq!(calls.last().unwrap(), &Recorded::Release);
    }

    #[test]
    fn relation_writes_stay_in_the_projector_transaction_without_nested_begin() {
        let observation_row = json!({
            "id":"o1", "user_id":"u1", "persona_id":"p1", "workspace_id":"w1",
            "source_type":"chat_message", "source_id":"s1", "occurred_at":"2026-10-11T10:00:00.000Z",
            "received_at":"2026-10-11T10:00:01.000Z", "payload":{}, "source_authority":"system"
        }).as_object().unwrap().clone();
        let entity = |id: &str, name: &str| {
            json!({"id":id,"canonical_name":name,"category":"person"})
                .as_object()
                .unwrap()
                .clone()
        };
        let relation_row = json!({
            "id":"r1", "user_id":"u1", "persona_id":"p1", "workspace_id":"w1",
            "source_entity_id":"e1", "target_entity_id":"e2", "relation_type":"knows",
            "direction":"outgoing", "confidence":0.8, "valid_from":"2026-10-11T10:00:00.000Z",
            "valid_to":null, "known_from":"2026-10-11T10:00:00.000Z", "known_to":null,
            "supersedes_relation_id":null, "source_observation_id":"o1"
        })
        .as_object()
        .unwrap()
        .clone();
        let executor = RecordingExecutor::new(vec![
            Ok(PgQueryResult::from_rows(vec![observation_row])),
            Ok(PgQueryResult::from_rows(vec![entity("e1", "Mira")])),
            Ok(PgQueryResult::from_rows(vec![entity("e2", "Kai")])),
            Ok(PgQueryResult::from_rows(vec![
                json!({"id":"e1"}).as_object().unwrap().clone(),
                json!({"id":"e2"}).as_object().unwrap().clone(),
            ])),
            Ok(PgQueryResult::empty()),
            Ok(PgQueryResult::empty()),
            Ok(PgQueryResult::from_rows(vec![relation_row])),
        ]);
        let projection = WorldModelProjection {
            assertions: vec![],
            events: vec![],
            entities: vec![],
            relations: vec![crate::world_model::projector::types::ProjectedRelation {
                source_entity: "Mira".into(),
                target_entity: "Kai".into(),
                relation_type: "knows".into(),
                confidence: 0.8,
                source_message_seq: 3,
            }],
            open_loops: vec![],
            tasks: vec![],
            confidence_summary: ConfidenceSummary {
                total: 1,
                confident: 0,
            },
        };
        let input = ProjectWindowInput {
            scope: WorldModelScope::new("u1", "p1", Some("w1".into())),
            projection,
            observation: ObservationInput {
                user_id: "u1".into(),
                persona_id: "p1".into(),
                workspace_id: Some("w1".into()),
                source_type: ObservationSourceType::ChatMessage,
                source_id: "s1".into(),
                occurred_at: "2026-10-11T10:00:00.000Z".into(),
                payload: Map::new(),
                source_authority: Some("system".into()),
            },
            extraction: None,
            completed_task_evidence: vec![],
        };
        let result = drive_sync(project_window(&executor, input))
            .unwrap()
            .unwrap();
        assert_eq!(result.relations_created, 1);
        let calls = executor.calls();
        let sqls = calls
            .iter()
            .map(|call| call.sql().to_string())
            .collect::<Vec<_>>();
        assert_eq!(
            sqls.iter().filter(|sql| sql.as_str() == SQL_BEGIN).count(),
            1
        );
        assert_eq!(
            sqls.iter().filter(|sql| sql.as_str() == SQL_COMMIT).count(),
            1
        );
        assert_eq!(
            sqls.iter()
                .filter(|sql| sql.as_str() == SQL_SET_SCOPE)
                .count(),
            1
        );
        assert!(sqls
            .iter()
            .any(|sql| sql.starts_with("INSERT INTO world_model_entity_relations")));
        assert_eq!(sqls.last().map(String::as_str), Some("<release>"));
    }
}
