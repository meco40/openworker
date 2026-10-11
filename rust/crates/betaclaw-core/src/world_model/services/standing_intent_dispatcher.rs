//! Port of `src/server/world-model/services/standingIntentDispatcher.ts:1-141`.
//!
//! | TypeScript | Rust |
//! | --- | --- |
//! | `standingIntentDispatcher.ts:14-17` (`StandingIntentDispatchInput`) | [`StandingIntentDispatchInput`] |
//! | `standingIntentDispatcher.ts:19-23` (`StandingIntentDispatchResult`) | [`StandingIntentDispatchResult`] |
//! | `standingIntentDispatcher.ts:30-70` (`executeStandingIntentFollowUp`) | [`execute_standing_intent_follow_up`] |
//! | `standingIntentDispatcher.ts:72-105` (`dispatchStandingIntentAction`) | [`dispatch_standing_intent_action`] |
//! | `standingIntentDispatcher.ts:112-148` (`buildIntentFiredHandler`) | [`build_intent_fired_handler`] |
//!
//! # Deviations
//!
//! 1. **The ambient scope is a parameter.** `:38-46` builds a
//!    `WorldModelScope` for `executeAction`, and `:80` hands the optional `db`
//!    to `enqueueOutboxEvent`. The port passes `Option<&WorldModelScope>` to the
//!    outbox repository, which is the documented replacement for
//!    `getWorldModelScope()`.
//! 2. **The wall clock is passed in.** `:61` writes `new Date().toISOString()`
//!    as the action receipt's `timestamp`; the port takes `now` for that field.
//! 3. **The thrown errors stay error values.** `:68` throws
//!    `result.error ?? 'standing intent follow-up action failed'` and `:138`
//!    throws `[world-model] no action handler for proactive.intent.fired`; the
//!    port answers `Err(PgError)` and `Err(String)` with the same literals.
//!    `buildIntentFiredHandler` returns a boxed [`IntentFiredHandler`] because
//!    Rust has no function type with an optional captured closure, and its
//!    `onAction?` argument becomes `Option<Arc<dyn Fn …>>`.

use std::sync::Arc;

use serde_json::{json, Map, Value};

use crate::world_model::db::{BoxFuture, PgError, PgExecutor};
use crate::world_model::repositories::action_attempt_repository::ToolActionResult;
use crate::world_model::repositories::outbox_repository::enqueue_outbox_event;
use crate::world_model::repositories::prospective_repository::insert_open_loop;
use crate::world_model::scope::WorldModelScope;
use crate::world_model::services::action_service::{
    execute_action, ActionRunResult, ExecuteActionInput,
};
use crate::world_model::types::{
    Observation, OpenLoopInput, OpenLoopType, OutboxEventInput, StandingIntentRecord,
};

/// `StandingIntentDispatchInput` from `standingIntentDispatcher.ts:14-17`.
#[derive(Debug, Clone, PartialEq)]
pub struct StandingIntentDispatchInput {
    pub intent: StandingIntentRecord,
    pub observation: Observation,
}

/// `StandingIntentDispatchResult` from `standingIntentDispatcher.ts:19-23`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StandingIntentDispatchResult {
    pub dispatched: bool,
    pub outbox_event_id: String,
    pub created: bool,
}

/// `standingIntentDispatcher.ts:68`.
pub const FOLLOW_UP_FAILED_MESSAGE: &str = "standing intent follow-up action failed";

/// `standingIntentDispatcher.ts:138`.
pub const NO_ACTION_HANDLER_MESSAGE: &str =
    "[world-model] no action handler for proactive.intent.fired";

/// The `{ intentId, userId, personaId, workspaceId?, description, firingObservationId }`
/// argument of `:30-37`.
#[derive(Debug, Clone, PartialEq)]
pub struct StandingIntentFollowUpInput {
    pub intent_id: String,
    pub user_id: String,
    pub persona_id: String,
    pub workspace_id: Option<String>,
    pub description: String,
    pub firing_observation_id: String,
}

/// `executeStandingIntentFollowUp(input)` — `standingIntentDispatcher.ts:30-70`.
pub async fn execute_standing_intent_follow_up(
    executor: &dyn PgExecutor,
    input: &StandingIntentFollowUpInput,
    now: Option<&str>,
) -> Result<(), PgError> {
    let workspace_id = input.workspace_id.clone().unwrap_or_default();
    let timestamp = now.map(str::to_string).unwrap_or_else(now_iso);
    let result = execute_action(
        executor,
        &ExecuteActionInput {
            scope: WorldModelScope::new(
                input.user_id.clone(),
                input.persona_id.clone(),
                input.workspace_id.clone(),
            ),
            task_id: None,
            action_type: "standing_intent.follow_up".to_string(),
            idempotency_key: format!(
                "standing-intent-action:{}:{}",
                input.intent_id, input.firing_observation_id
            ),
            correlation_id: Some(input.firing_observation_id.clone()),
        },
        || {
            let user_id = input.user_id.clone();
            let persona_id = input.persona_id.clone();
            let description = input.description.clone();
            let intent_id = input.intent_id.clone();
            let firing_observation_id = input.firing_observation_id.clone();
            let timestamp = timestamp.clone();
            async move {
                let loop_record = insert_open_loop::<PgError>(
                    executor,
                    None,
                    &OpenLoopInput {
                        user_id,
                        persona_id,
                        workspace_id: Some(workspace_id),
                        loop_type: OpenLoopType::PromisedFollowUp,
                        subject_id: None,
                        question: Some(format!("Erinnerung: {description}")),
                        missing_information: None,
                        importance: None,
                        trigger_at: None,
                        do_not_ask_before: None,
                        deduplication_key: format!(
                            "standing-intent-follow-up:{intent_id}:{firing_observation_id}"
                        ),
                        max_attempts: None,
                    },
                )
                .await
                .map_err(|error| error.message)?;
                Ok(ActionRunResult {
                    ok: true,
                    error: None,
                    result: Some(ToolActionResult {
                        provider_id: Some("world-model".to_string()),
                        target: Some(format!("open-loop:{}", loop_record.id)),
                        timestamp: Some(timestamp),
                        payload: Some(json!({
                            "intentId": intent_id,
                            "firingObservationId": firing_observation_id,
                        })),
                    }),
                })
            }
        },
    )
    .await?;

    if !result.succeeded {
        return Err(PgError::new(
            result
                .error
                .unwrap_or_else(|| FOLLOW_UP_FAILED_MESSAGE.to_string()),
        ));
    }
    Ok(())
}

/// `new Date().toISOString()`, shared with the assertion repository.
fn now_iso() -> String {
    crate::world_model::repositories::assertion_repository::now_iso()
}

/// The `payload` object literal of `:89-99`.
fn dispatch_payload(input: &StandingIntentDispatchInput) -> Map<String, Value> {
    let intent = &input.intent;
    let mut payload = Map::new();
    payload.insert("userId".into(), Value::String(intent.input.user_id.clone()));
    payload.insert(
        "personaId".into(),
        Value::String(intent.input.persona_id.clone()),
    );
    payload.insert(
        "workspaceId".into(),
        Value::String(intent.input.workspace_id.clone().unwrap_or_default()),
    );
    payload.insert("intentId".into(), Value::String(intent.id.clone()));
    payload.insert(
        "description".into(),
        Value::String(intent.input.description.clone()),
    );
    payload.insert("triggerTerms".into(), json!(intent.input.trigger_terms));
    payload.insert(
        "firingObservationId".into(),
        Value::String(input.observation.id.clone()),
    );
    payload.insert(
        "sourceType".into(),
        serde_json::to_value(input.observation.input.source_type).unwrap_or(Value::Null),
    );
    payload.insert(
        "firedAt".into(),
        Value::String(input.observation.input.occurred_at.clone()),
    );
    payload
}

/// `dispatchStandingIntentAction(input, db?)` — `standingIntentDispatcher.ts:72-105`.
pub async fn dispatch_standing_intent_action(
    executor: &dyn PgExecutor,
    scope: Option<&WorldModelScope>,
    input: &StandingIntentDispatchInput,
) -> Result<StandingIntentDispatchResult, PgError> {
    let intent = &input.intent;
    let event = enqueue_outbox_event::<PgError>(
        executor,
        scope,
        &OutboxEventInput {
            event_type: "proactive.intent.fired".to_string(),
            aggregate_type: "standing_intent".to_string(),
            aggregate_id: intent.id.clone(),
            payload: dispatch_payload(input),
            idempotency_key: Some(format!(
                "standing-intent-fire:{}:{}",
                intent.id, input.observation.id
            )),
            correlation_id: None,
            user_id: Some(intent.input.user_id.clone()),
            persona_id: Some(intent.input.persona_id.clone()),
            workspace_id: Some(intent.input.workspace_id.clone().unwrap_or_default()),
        },
    )
    .await?;

    Ok(StandingIntentDispatchResult {
        dispatched: true,
        outbox_event_id: event.id,
        // `event.created !== false` — `:104`.
        created: event.created.unwrap_or(true),
    })
}

/// The event argument of the handler (`:122-127`).
#[derive(Debug, Clone, PartialEq)]
pub struct IntentFiredEvent {
    pub id: String,
    pub event_type: String,
    pub aggregate_type: String,
    pub aggregate_id: String,
    pub payload: Map<String, Value>,
}

/// The `onAction` argument of `:112-120`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IntentFiredAction {
    pub intent_id: String,
    pub user_id: String,
    pub persona_id: String,
    pub workspace_id: Option<String>,
    pub description: String,
    pub firing_observation_id: String,
}

/// `onAction?: (payload) => Promise<void>` of `:112-121`.
pub type IntentFiredActionHandler =
    Arc<dyn Fn(IntentFiredAction) -> BoxFuture<'static, Result<(), String>> + Send + Sync>;

/// The returned `(event) => Promise<void>` of `:122-148`.
pub type IntentFiredHandler =
    Arc<dyn Fn(IntentFiredEvent) -> BoxFuture<'static, Result<(), String>> + Send + Sync>;

/// `String(value)` — `:130-134`.
fn js_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => number.to_string(),
        Value::Null => "null".to_string(),
        other => other.to_string(),
    }
}

/// `payload.<key> ? String(payload.<key>) : undefined` — `:135`.
fn optional_js_string(payload: &Map<String, Value>, key: &str) -> Option<String> {
    match payload.get(key) {
        None | Some(Value::Null) => None,
        Some(Value::Bool(false)) => None,
        Some(Value::Number(number)) if number.as_f64() == Some(0.0) => None,
        Some(Value::String(text)) if text.is_empty() => None,
        Some(value) => Some(js_string(value)),
    }
}

/// `String(payload.<key> ?? fallback)` — `:130-134`.
fn payload_string(payload: &Map<String, Value>, key: &str) -> String {
    payload.get(key).map(js_string).unwrap_or_default()
}

/// `buildIntentFiredHandler(onAction?)` — `standingIntentDispatcher.ts:112-148`.
pub fn build_intent_fired_handler(
    on_action: Option<IntentFiredActionHandler>,
) -> IntentFiredHandler {
    Arc::new(move |event: IntentFiredEvent| {
        let on_action = on_action.clone();
        Box::pin(async move {
            let payload = event.payload.clone();
            let intent_id_fallback = event.aggregate_id.clone();
            let intent_id = match payload.get("intentId") {
                Some(value) => js_string(value),
                None => intent_id_fallback,
            };
            let action = IntentFiredAction {
                intent_id,
                user_id: payload_string(&payload, "userId"),
                persona_id: payload_string(&payload, "personaId"),
                workspace_id: optional_js_string(&payload, "workspaceId"),
                description: payload_string(&payload, "description"),
                firing_observation_id: payload_string(&payload, "firingObservationId"),
            };
            let Some(on_action) = on_action else {
                return Err(NO_ACTION_HANDLER_MESSAGE.to_string());
            };
            on_action(action).await
        }) as BoxFuture<'static, Result<(), String>>
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world_model::db::testing::{Recorded, RecordingExecutor};
    use crate::world_model::db::{drive_sync, PgQueryResult, PgRow, PgValue};
    use crate::world_model::repositories::outbox_repository::SQL_ENQUEUE_OUTBOX;
    use crate::world_model::types::{
        ObservationInput, ObservationSourceType, StandingIntentInput, StandingIntentStatus,
    };

    fn intent() -> StandingIntentRecord {
        StandingIntentRecord {
            input: StandingIntentInput {
                user_id: "u1".into(),
                persona_id: "p1".into(),
                workspace_id: Some("w1".into()),
                description: "Erinnere mich an das Angebot".into(),
                trigger_terms: vec!["mike".into()],
                event_type: None,
                subject_scope: None,
                channel_scope: None,
                sender_scope: None,
                expires_at: None,
                cooldown_ms: None,
                max_fires: None,
                deduplication_key: "intent-key".into(),
            },
            id: "si1".into(),
            status: StandingIntentStatus::Armed,
            cooldown_until: None,
            fire_count: 0,
            last_fired_at: None,
            created_at: "2026-10-10T10:00:00.000Z".into(),
            updated_at: "2026-10-10T10:00:00.000Z".into(),
        }
    }

    fn observation() -> Observation {
        Observation {
            input: ObservationInput {
                user_id: "u1".into(),
                persona_id: "p1".into(),
                workspace_id: Some("w1".into()),
                source_type: ObservationSourceType::ChatMessage,
                source_id: "m1".into(),
                occurred_at: "2026-10-10T10:05:00.000Z".into(),
                payload: Map::new(),
                source_authority: None,
            },
            id: "o1".into(),
            received_at: "2026-10-10T10:05:00.000Z".into(),
        }
    }

    fn outbox_row() -> PgQueryResult {
        let row: PgRow = json!({
            "id": "ob1", "event_type": "proactive.intent.fired",
            "aggregate_type": "standing_intent", "aggregate_id": "si1", "payload": {},
            "status": "pending", "attempts": 0, "error_message": null,
            "created_at": "2026-10-10T10:05:00.000Z", "dispatched_at": null,
            "inserted": true
        })
        .as_object()
        .unwrap()
        .clone();
        PgQueryResult::from_rows(vec![row])
    }

    #[test]
    fn a_fired_intent_is_enqueued_with_the_source_idempotency_key() {
        let executor = RecordingExecutor::new(vec![Ok(outbox_row())]);
        let result = drive_sync(dispatch_standing_intent_action(
            &executor,
            None,
            &StandingIntentDispatchInput {
                intent: intent(),
                observation: observation(),
            },
        ))
        .expect("bridge")
        .expect("dispatch");
        assert!(result.dispatched);
        assert!(result.created);
        assert_eq!(result.outbox_event_id, "ob1");

        match &executor.calls()[0] {
            Recorded::Statement(statement) => {
                assert_eq!(statement.sql, SQL_ENQUEUE_OUTBOX);
                assert_eq!(
                    statement.params[4],
                    PgValue::text("standing-intent-fire:si1:o1")
                );
                assert_eq!(statement.params[8], PgValue::text("w1"));
                // The payload carries the firing context of `:89-99`.
                let PgValue::Text(raw) = &statement.params[3] else {
                    panic!("expected the payload text");
                };
                let payload: Value = serde_json::from_str(raw).expect("payload json");
                assert_eq!(payload["intentId"], json!("si1"));
                assert_eq!(payload["firingObservationId"], json!("o1"));
                assert_eq!(payload["sourceType"], json!("chat_message"));
                assert_eq!(payload["firedAt"], json!("2026-10-10T10:05:00.000Z"));
            }
            other => panic!("expected the outbox insert, got {other:?}"),
        }
        // The unscoped `pg` path is a single `pool.query`, without a
        // transaction and without a release (`db.ts:107-110`).
        assert_eq!(executor.calls().len(), 1);
    }

    #[test]
    fn the_intent_fired_handler_without_a_callback_keeps_the_source_message() {
        let handler = build_intent_fired_handler(None);
        let error = drive_sync(handler(IntentFiredEvent {
            id: "ob1".into(),
            event_type: "proactive.intent.fired".into(),
            aggregate_type: "standing_intent".into(),
            aggregate_id: "si1".into(),
            payload: Map::new(),
        }))
        .expect("bridge")
        .expect_err("no handler");
        assert_eq!(error, NO_ACTION_HANDLER_MESSAGE);
    }

    #[test]
    fn the_intent_fired_handler_falls_back_to_the_aggregate_id() {
        let captured: Arc<std::sync::Mutex<Option<IntentFiredAction>>> =
            Arc::new(std::sync::Mutex::new(None));
        let sink = Arc::clone(&captured);
        let handler = build_intent_fired_handler(Some(Arc::new(move |action| {
            let sink = Arc::clone(&sink);
            Box::pin(async move {
                *sink.lock().expect("sink") = Some(action);
                Ok(())
            })
        })));
        let mut payload = Map::new();
        payload.insert("userId".into(), json!("u1"));
        payload.insert("personaId".into(), json!("p1"));
        payload.insert("description".into(), json!("Erinnere mich"));
        payload.insert("firingObservationId".into(), json!("o1"));
        drive_sync(handler(IntentFiredEvent {
            id: "ob1".into(),
            event_type: "proactive.intent.fired".into(),
            aggregate_type: "standing_intent".into(),
            aggregate_id: "si1".into(),
            payload,
        }))
        .expect("bridge")
        .expect("handled");
        let action = captured.lock().expect("sink").clone().expect("action");
        assert_eq!(action.intent_id, "si1");
        assert_eq!(action.user_id, "u1");
        assert_eq!(action.persona_id, "p1");
        assert_eq!(action.workspace_id, None);
        assert_eq!(action.firing_observation_id, "o1");
    }
}
