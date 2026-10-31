//! Port of `src/server/world-model/services/missionControlBridge.ts:1-376` —
//! the bridge between Mission-Control tasks/actions and the canonical World
//! Model.
//!
//! | TypeScript | Rust |
//! | --- | --- |
//! | `missionControlBridge.ts:28-37` (`MissionControlTaskContext`) | [`MissionControlTaskContext`] |
//! | `missionControlBridge.ts:40-56` (`toWorldModelTaskStatus`) | [`to_world_model_task_status`] |
//! | `missionControlBridge.ts:58-64` (`MissionControlActionResult`) | [`MissionControlActionResult`] |
//! | `missionControlBridge.ts:69-126` (`mirrorTaskStatusChange`) | [`mirror_task_status_change`] |
//! | `missionControlBridge.ts:132-185` (`executeMissionControlAction`) | [`execute_mission_control_action`] |
//! | `missionControlBridge.ts:190-224` (`mirrorTaskCreation`) | [`mirror_task_creation`] |
//! | `missionControlBridge.ts:229-264` (`mirrorTaskDeletion`) | [`mirror_task_deletion`] |
//! | `missionControlBridge.ts:270-282` (`validateTaskTransition`) | [`validate_task_transition`] |
//! | `missionControlBridge.ts:284-307` (`requiredPayloadString`, `payloadWorldModelStatus`) | [`required_payload_string`], [`payload_world_model_status`] |
//! | `missionControlBridge.ts:310-348` (`projectMissionControlTaskCreated`) | [`project_mission_control_task_created`] |
//! | `missionControlBridge.ts:350-366` (`projectMissionControlTaskStatusChanged`) | [`project_mission_control_task_status_changed`] |
//! | `missionControlBridge.ts:368-376` (`projectMissionControlTaskDeleted`) | [`project_mission_control_task_deleted`] |
//!
//! # Deviations
//!
//! 1. **The ambient scope is a parameter.** `runWithWorldModelScope` and
//!    `withWorldModelTransaction` read `getWorldModelScope()`; the port takes the
//!    [`WorldModelScope`] as an argument.
//! 2. **`getWorldModelConfig()` is a parameter.** The callers own the
//!    environment lookup so the mirrored functions stay deterministic.
//! 3. **`new Date().toISOString()` is supplied as `now`** (`:116`, `:214`,
//!    `:254`).
//! 4. **`MissionControlTaskStatus`** (`@/lib/types`) is modelled as an enum with
//!    the same eight literals; the source is a string union of the task store.

use std::future::Future;

use serde_json::{json, Map, Value};

use crate::world_model::config::WorldModelConfig;
use crate::world_model::db::{PgError, PgExecutor};
use crate::world_model::repositories::action_attempt_repository::ToolActionResult;
use crate::world_model::repositories::ambient_transaction;
use crate::world_model::repositories::outbox_repository::enqueue_outbox_event;
use crate::world_model::repositories::task_repository::{
    get_task_by_id, insert_task, update_task_status_by_external_id, WorldModelTaskInput,
};
use crate::world_model::scope::WorldModelScope;
use crate::world_model::services::action_service::{
    execute_action, ActionRunResult, ExecuteActionInput,
};
use crate::world_model::services::canonical_task_service::{
    resolve_task_transition, TaskTransitionReason,
};
use crate::world_model::types::{OutboxEvent, OutboxEventInput, TaskStatus};

/// `TaskStatus as MissionControlTaskStatus` of `@/lib/types` — deviation 4.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MissionControlTaskStatus {
    Inbox,
    PendingDispatch,
    Planning,
    Assigned,
    InProgress,
    Testing,
    Review,
    Done,
}

impl MissionControlTaskStatus {
    pub fn text(self) -> &'static str {
        match self {
            MissionControlTaskStatus::Inbox => "inbox",
            MissionControlTaskStatus::PendingDispatch => "pending_dispatch",
            MissionControlTaskStatus::Planning => "planning",
            MissionControlTaskStatus::Assigned => "assigned",
            MissionControlTaskStatus::InProgress => "in_progress",
            MissionControlTaskStatus::Testing => "testing",
            MissionControlTaskStatus::Review => "review",
            MissionControlTaskStatus::Done => "done",
        }
    }

    pub fn from_text(text: &str) -> Option<Self> {
        match text {
            "inbox" => Some(MissionControlTaskStatus::Inbox),
            "pending_dispatch" => Some(MissionControlTaskStatus::PendingDispatch),
            "planning" => Some(MissionControlTaskStatus::Planning),
            "assigned" => Some(MissionControlTaskStatus::Assigned),
            "in_progress" => Some(MissionControlTaskStatus::InProgress),
            "testing" => Some(MissionControlTaskStatus::Testing),
            "review" => Some(MissionControlTaskStatus::Review),
            "done" => Some(MissionControlTaskStatus::Done),
            _ => None,
        }
    }
}

/// `toWorldModelTaskStatus(status)` — `missionControlBridge.ts:40-56`.
pub fn to_world_model_task_status(status: MissionControlTaskStatus) -> TaskStatus {
    match status {
        MissionControlTaskStatus::Inbox => TaskStatus::Proposed,
        MissionControlTaskStatus::PendingDispatch | MissionControlTaskStatus::Planning => {
            TaskStatus::Planned
        }
        MissionControlTaskStatus::Assigned | MissionControlTaskStatus::InProgress => {
            TaskStatus::InProgress
        }
        MissionControlTaskStatus::Testing | MissionControlTaskStatus::Review => TaskStatus::Waiting,
        MissionControlTaskStatus::Done => TaskStatus::Completed,
    }
}

/// The union literal of a [`TaskStatus`] (`types.ts:19-26`).
fn task_status_text(status: TaskStatus) -> &'static str {
    match status {
        TaskStatus::Proposed => "proposed",
        TaskStatus::Planned => "planned",
        TaskStatus::InProgress => "in_progress",
        TaskStatus::Waiting => "waiting",
        TaskStatus::Completed => "completed",
        TaskStatus::Cancelled => "cancelled",
        TaskStatus::Failed => "failed",
    }
}

/// `MissionControlTaskContext` from `missionControlBridge.ts:28-37`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MissionControlTaskContext {
    pub task_id: String,
    pub user_id: String,
    pub persona_id: String,
    pub workspace_id: String,
    pub title: String,
    pub status: MissionControlTaskStatus,
    pub assigned_agent_id: Option<String>,
    pub due_date: Option<String>,
}

/// `MissionControlActionResult` from `missionControlBridge.ts:58-64`.
#[derive(Debug, Clone, PartialEq)]
pub struct MissionControlActionResult {
    pub attempt_id: String,
    pub created: bool,
    pub succeeded: bool,
    pub error: Option<String>,
    pub result: Option<ToolActionResult>,
}

/// The `input` of `executeMissionControlAction` — `:132-138`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MissionControlActionInput {
    pub scope: WorldModelScope,
    pub task_id: String,
    pub action_type: String,
    pub idempotency_key: String,
    pub correlation_id: Option<String>,
}

/// The `{ allowed, reason }` of `validateTaskTransition` — `:273`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskTransitionValidation {
    pub allowed: bool,
    pub reason: String,
}

/// `validateTaskTransition(from, to)` — `missionControlBridge.ts:270-282`.
pub fn validate_task_transition(
    from: Option<MissionControlTaskStatus>,
    to: MissionControlTaskStatus,
) -> TaskTransitionValidation {
    let result = resolve_task_transition(
        from.map(to_world_model_task_status),
        to_world_model_task_status(to),
    );
    TaskTransitionValidation {
        allowed: result.allowed,
        reason: match result.reason {
            TaskTransitionReason::Ok => "ok",
            TaskTransitionReason::InvalidTransition => "invalid_transition",
            TaskTransitionReason::NotFound => "not_found",
        }
        .to_string(),
    }
}

/// `String(value)` of a payload value, matching the source's coercion.
fn js_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => number.to_string(),
        other => other.to_string(),
    }
}

/// `requiredPayloadString(event, key)` — `missionControlBridge.ts:284-290`.
pub fn required_payload_string(event: &OutboxEvent, key: &str) -> Result<String, PgError> {
    let raw = event.input.payload.get(key);
    let value = match raw {
        Some(Value::Null) | None => {
            if key == "taskId" {
                Some(Value::String(event.input.aggregate_id.clone()))
            } else {
                None
            }
        }
        Some(other) => Some(other.clone()),
    };
    match value {
        Some(Value::String(text)) if !text.is_empty() => Ok(text),
        _ => Err(PgError::new(format!(
            "[world-model:mission-control] missing {} in {}",
            key, event.input.event_type
        ))),
    }
}

/// `payloadWorldModelStatus(event, key)` — `missionControlBridge.ts:292-307`.
pub fn payload_world_model_status(event: &OutboxEvent, key: &str) -> Result<TaskStatus, PgError> {
    const STATUSES: [TaskStatus; 7] = [
        TaskStatus::Proposed,
        TaskStatus::Planned,
        TaskStatus::InProgress,
        TaskStatus::Waiting,
        TaskStatus::Completed,
        TaskStatus::Cancelled,
        TaskStatus::Failed,
    ];
    match event.input.payload.get(key) {
        Some(Value::String(text)) => STATUSES
            .iter()
            .copied()
            .find(|status| task_status_text(*status) == text)
            .ok_or_else(|| {
                PgError::new(format!(
                    "[world-model:mission-control] invalid {} in {}",
                    key, event.input.event_type
                ))
            }),
        _ => Err(PgError::new(format!(
            "[world-model:mission-control] invalid {} in {}",
            key, event.input.event_type
        ))),
    }
}

/// The `world.task.status_changed` payload of `:104-117`.
fn status_changed_payload(
    context: &MissionControlTaskContext,
    canonical_previous: Option<TaskStatus>,
    canonical_status: TaskStatus,
    previous_status: Option<MissionControlTaskStatus>,
    now: &str,
) -> Map<String, Value> {
    let mut payload = Map::new();
    payload.insert("taskId".into(), json!(context.task_id));
    payload.insert("userId".into(), json!(context.user_id));
    payload.insert("personaId".into(), json!(context.persona_id));
    payload.insert("workspaceId".into(), json!(context.workspace_id));
    payload.insert("title".into(), json!(context.title));
    if let Some(previous) = canonical_previous {
        payload.insert("previousStatus".into(), json!(task_status_text(previous)));
    }
    payload.insert(
        "newStatus".into(),
        json!(task_status_text(canonical_status)),
    );
    if let Some(previous) = previous_status {
        payload.insert("sourcePreviousStatus".into(), json!(previous.text()));
    }
    payload.insert("sourceNewStatus".into(), json!(context.status.text()));
    if let Some(agent) = &context.assigned_agent_id {
        payload.insert("assignedAgentId".into(), json!(agent));
    }
    if let Some(due_date) = &context.due_date {
        payload.insert("dueDate".into(), json!(due_date));
    }
    payload.insert("changedAt".into(), json!(now));
    payload
}

/// `mirrorTaskStatusChange(context, previousStatus)` —
/// `missionControlBridge.ts:69-126`.
pub async fn mirror_task_status_change(
    executor: &dyn PgExecutor,
    scope: Option<&WorldModelScope>,
    config: &WorldModelConfig,
    context: &MissionControlTaskContext,
    previous_status: Option<MissionControlTaskStatus>,
    now: &str,
) -> Result<(), PgError> {
    if !config.enabled && !config.e2e_enabled {
        return Ok(());
    }
    let canonical_previous = previous_status.map(to_world_model_task_status);
    let canonical_status = to_world_model_task_status(context.status);
    let transition = resolve_task_transition(canonical_previous, canonical_status);
    if !transition.allowed {
        if config.mode.is_required() {
            return Err(PgError::new(format!(
                "[world-model:mission-control] invalid task transition: {} -> {}",
                previous_status
                    .map(MissionControlTaskStatus::text)
                    .unwrap_or("undefined"),
                context.status.text()
            )));
        }
        return Ok(());
    }

    let payload = status_changed_payload(
        context,
        canonical_previous,
        canonical_status,
        previous_status,
        now,
    );
    let input = OutboxEventInput {
        event_type: "world.task.status_changed".to_string(),
        aggregate_type: "task".to_string(),
        aggregate_id: context.task_id.clone(),
        payload,
        idempotency_key: Some(format!(
            "task-status:{}:{}",
            context.task_id,
            context.status.text()
        )),
        correlation_id: None,
        user_id: Some(context.user_id.clone()),
        persona_id: Some(context.persona_id.clone()),
        workspace_id: Some(context.workspace_id.clone()),
    };
    let outcome = ambient_transaction::<(), PgError>(
        executor,
        scope,
        Box::new(move |session| {
            Box::pin(async move {
                let transaction_executor = SessionExecutor(session);
                enqueue_outbox_event::<PgError>(&transaction_executor, None, &input)
                    .await
                    .map(|_| ())
            })
        }),
    )
    .await;
    match outcome {
        Ok(()) => Ok(()),
        Err(error) => {
            if config.mode.is_required() {
                Err(error)
            } else {
                Ok(())
            }
        }
    }
}

/// The transaction executor the mirrored writes receive.
struct SessionExecutor(std::sync::Arc<dyn crate::world_model::db::PgSession>);

impl PgExecutor for SessionExecutor {
    fn connect<'a>(
        &'a self,
    ) -> crate::world_model::db::BoxFuture<
        'a,
        Result<std::sync::Arc<dyn crate::world_model::db::PgSession>, PgError>,
    > {
        Box::pin(async { Err(PgError::new("[world-model] nested transaction")) })
    }

    fn query<'a>(
        &'a self,
        statement: crate::world_model::db::PgStatement,
    ) -> crate::world_model::db::BoxFuture<'a, Result<crate::world_model::db::PgQueryResult, PgError>>
    {
        self.0.query(statement)
    }
}

/// `executeMissionControlAction(input)` — `missionControlBridge.ts:132-185`.
pub async fn execute_mission_control_action<F, Fut>(
    executor: &dyn PgExecutor,
    config: &WorldModelConfig,
    input: &MissionControlActionInput,
    run: F,
) -> Result<MissionControlActionResult, PgError>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = ActionRunResult>,
{
    if !config.enabled && !config.e2e_enabled {
        let result = run().await;
        return Ok(MissionControlActionResult {
            attempt_id: format!("direct-{}", input.idempotency_key),
            created: true,
            succeeded: result.ok,
            error: result.error,
            result: result.result,
        });
    }

    // Master run IDs are not necessarily canonical task IDs; only link an
    // existing canonical task (`:164-175`).
    let canonical_task_id =
        match get_task_by_id::<PgError>(executor, Some(&input.scope), &input.task_id).await {
            Ok(Some(_)) => Some(input.task_id.clone()),
            _ => None,
        };
    let action = execute_action(
        executor,
        &ExecuteActionInput {
            scope: input.scope.clone(),
            task_id: canonical_task_id,
            action_type: input.action_type.clone(),
            idempotency_key: input.idempotency_key.clone(),
            correlation_id: input.correlation_id.clone(),
        },
        || async { Ok(run().await) },
    )
    .await?;
    Ok(MissionControlActionResult {
        attempt_id: action.attempt_id,
        created: action.created,
        succeeded: action.succeeded,
        error: action.error,
        result: action.result,
    })
}

/// The `world.task.created` payload of `:205-215`.
fn task_created_payload(context: &MissionControlTaskContext, now: &str) -> Map<String, Value> {
    let mut payload = Map::new();
    payload.insert("taskId".into(), json!(context.task_id));
    payload.insert("userId".into(), json!(context.user_id));
    payload.insert("personaId".into(), json!(context.persona_id));
    payload.insert("workspaceId".into(), json!(context.workspace_id));
    payload.insert("title".into(), json!(context.title));
    payload.insert("status".into(), json!(context.status.text()));
    if let Some(agent) = &context.assigned_agent_id {
        payload.insert("assignedAgentId".into(), json!(agent));
    }
    if let Some(due_date) = &context.due_date {
        payload.insert("dueDate".into(), json!(due_date));
    }
    payload.insert("createdAt".into(), json!(now));
    payload
}

/// `mirrorTaskCreation(context)` — `missionControlBridge.ts:190-224`.
pub async fn mirror_task_creation(
    executor: &dyn PgExecutor,
    scope: Option<&WorldModelScope>,
    config: &WorldModelConfig,
    context: &MissionControlTaskContext,
    now: &str,
) -> Result<(), PgError> {
    if !config.enabled && !config.e2e_enabled {
        return Ok(());
    }
    let input = OutboxEventInput {
        event_type: "world.task.created".to_string(),
        aggregate_type: "task".to_string(),
        aggregate_id: context.task_id.clone(),
        payload: task_created_payload(context, now),
        idempotency_key: Some(format!("task-created:{}", context.task_id)),
        correlation_id: None,
        user_id: Some(context.user_id.clone()),
        persona_id: Some(context.persona_id.clone()),
        workspace_id: Some(context.workspace_id.clone()),
    };
    let outcome = enqueue_in_transaction(executor, scope, input).await;
    match outcome {
        Ok(()) => Ok(()),
        Err(error) => {
            if config.mode.is_required() {
                Err(error)
            } else {
                Ok(())
            }
        }
    }
}

/// `mirrorTaskDeletion(taskId, userId, personaId, workspaceId)` —
/// `missionControlBridge.ts:229-264`.
#[allow(clippy::too_many_arguments)]
pub async fn mirror_task_deletion(
    executor: &dyn PgExecutor,
    scope: Option<&WorldModelScope>,
    config: &WorldModelConfig,
    task_id: &str,
    user_id: &str,
    persona_id: &str,
    workspace_id: &str,
    now: &str,
) -> Result<(), PgError> {
    if !config.enabled && !config.e2e_enabled {
        return Ok(());
    }
    let input = OutboxEventInput {
        event_type: "world.task.deleted".to_string(),
        aggregate_type: "task".to_string(),
        aggregate_id: task_id.to_string(),
        payload: json!({
            "taskId": task_id,
            "userId": user_id,
            "personaId": persona_id,
            "workspaceId": workspace_id,
            "deletedAt": now,
        })
        .as_object()
        .cloned()
        .unwrap_or_default(),
        idempotency_key: Some(format!("task-deleted:{task_id}")),
        correlation_id: None,
        user_id: Some(user_id.to_string()),
        persona_id: Some(persona_id.to_string()),
        workspace_id: Some(workspace_id.to_string()),
    };
    let outcome = enqueue_in_transaction(executor, scope, input).await;
    match outcome {
        Ok(()) => Ok(()),
        Err(error) => {
            if config.mode.is_required() {
                Err(error)
            } else {
                Ok(())
            }
        }
    }
}

/// The `withWorldModelTransaction(client => enqueueOutboxEvent(..., client))`
/// of `:195-219` and `:239-259`.
async fn enqueue_in_transaction(
    executor: &dyn PgExecutor,
    scope: Option<&WorldModelScope>,
    input: OutboxEventInput,
) -> Result<(), PgError> {
    ambient_transaction::<(), PgError>(
        executor,
        scope,
        Box::new(move |session| {
            Box::pin(async move {
                let transaction_executor = SessionExecutor(session);
                enqueue_outbox_event::<PgError>(&transaction_executor, None, &input)
                    .await
                    .map(|_| ())
            })
        }),
    )
    .await
}

/// The `workspaceId` coercion of `:314`, `:354`, `:372`
/// (`String(event.payload.workspaceId ?? event.workspaceId ?? '')`).
fn event_workspace_id(event: &OutboxEvent) -> String {
    let raw = match event.input.payload.get("workspaceId") {
        Some(Value::Null) | None => event.input.workspace_id.clone().map(Value::String),
        Some(other) => Some(other.clone()),
    };
    raw.map(|value| js_string(&value)).unwrap_or_default()
}

/// `projectMissionControlTaskCreated(event)` — `missionControlBridge.ts:310-348`.
pub async fn project_mission_control_task_created(
    executor: &dyn PgExecutor,
    scope: Option<&WorldModelScope>,
    event: &OutboxEvent,
) -> Result<(), PgError> {
    let task_id = required_payload_string(event, "taskId")?;
    let user_id = required_payload_string(event, "userId")?;
    let persona_id = required_payload_string(event, "personaId")?;
    let workspace_id = event_workspace_id(event);
    let title = required_payload_string(event, "title")?;
    let source_status = match event.input.payload.get("status") {
        Some(Value::String(text)) => {
            MissionControlTaskStatus::from_text(text).ok_or_else(|| {
                PgError::new(format!(
                    "[world-model:mission-control] invalid status in {}",
                    event.input.event_type
                ))
            })?
        }
        _ => {
            return Err(PgError::new(format!(
                "[world-model:mission-control] invalid status in {}",
                event.input.event_type
            )))
        }
    };
    let assignee = match event.input.payload.get("assignedAgentId") {
        Some(Value::String(agent)) => agent.clone(),
        _ => user_id.clone(),
    };
    insert_task::<PgError>(
        executor,
        scope,
        &WorldModelTaskInput {
            user_id: user_id.clone(),
            persona_id,
            workspace_id,
            title,
            description: None,
            requester: Some(user_id.clone()),
            assignee: Some(assignee),
            external_task_id: Some(task_id.clone()),
            origin: Some("mission_control".to_string()),
            status: Some(to_world_model_task_status(source_status)),
            due_at: match event.input.payload.get("dueDate") {
                Some(Value::String(due)) => Some(due.clone()),
                _ => None,
            },
            idempotency_key: Some(format!("task-created:{task_id}")),
            source_observation_id: None,
        },
    )
    .await?;
    Ok(())
}

/// `projectMissionControlTaskStatusChanged(event)` —
/// `missionControlBridge.ts:350-366`.
pub async fn project_mission_control_task_status_changed(
    executor: &dyn PgExecutor,
    scope: Option<&WorldModelScope>,
    event: &OutboxEvent,
) -> Result<(), PgError> {
    let task_id = required_payload_string(event, "taskId")?;
    let user_id = required_payload_string(event, "userId")?;
    let persona_id = required_payload_string(event, "personaId")?;
    let workspace_id = event_workspace_id(event);
    let status = payload_world_model_status(event, "newStatus")?;
    let updated = update_task_status_by_external_id::<PgError>(
        executor,
        scope,
        &task_id,
        &user_id,
        &persona_id,
        &workspace_id,
        status,
    )
    .await?;
    if !updated {
        return Err(PgError::new(format!(
            "[world-model:mission-control] task {task_id} is not projected yet"
        )));
    }
    Ok(())
}

/// `projectMissionControlTaskDeleted(event)` —
/// `missionControlBridge.ts:368-376`.
pub async fn project_mission_control_task_deleted(
    executor: &dyn PgExecutor,
    scope: Option<&WorldModelScope>,
    event: &OutboxEvent,
) -> Result<(), PgError> {
    let task_id = required_payload_string(event, "taskId")?;
    let user_id = required_payload_string(event, "userId")?;
    let persona_id = required_payload_string(event, "personaId")?;
    let workspace_id = event_workspace_id(event);
    let _ = update_task_status_by_external_id::<PgError>(
        executor,
        scope,
        &task_id,
        &user_id,
        &persona_id,
        &workspace_id,
        TaskStatus::Cancelled,
    )
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world_model::db::testing::{Recorded, RecordingExecutor};
    use crate::world_model::db::{drive_sync, PgQueryResult, PgRow, SQL_BEGIN, SQL_COMMIT};
    use crate::world_model::mode::WorldModelMode;
    use serde_json::json;

    fn row(value: serde_json::Value) -> PgRow {
        value.as_object().expect("row object").clone()
    }

    fn outbox_row() -> PgRow {
        row(json!({
            "id": "x1", "event_type": "world.task.created", "aggregate_type": "task",
            "aggregate_id": "t1", "payload": {}, "status": "pending", "attempts": 0,
            "error_message": null, "created_at": "2026-10-11T10:00:00.000Z",
            "dispatched_at": null, "idempotency_key": "task-created:t1", "correlation_id": null,
            "user_id": "u1", "persona_id": "p1", "workspace_id": "w1", "inserted": true
        }))
    }

    fn config(mode: WorldModelMode) -> WorldModelConfig {
        WorldModelConfig {
            enabled: true,
            mode,
            ..WorldModelConfig::default()
        }
    }

    fn context(status: MissionControlTaskStatus) -> MissionControlTaskContext {
        MissionControlTaskContext {
            task_id: "t1".into(),
            user_id: "u1".into(),
            persona_id: "p1".into(),
            workspace_id: "w1".into(),
            title: "Task".into(),
            status,
            assigned_agent_id: None,
            due_date: None,
        }
    }

    fn outbox_event(payload: serde_json::Value) -> OutboxEvent {
        OutboxEvent {
            input: OutboxEventInput {
                event_type: "world.task.created".into(),
                aggregate_type: "task".into(),
                aggregate_id: "t1".into(),
                payload: payload.as_object().cloned().unwrap_or_default(),
                idempotency_key: None,
                correlation_id: None,
                user_id: None,
                persona_id: None,
                workspace_id: None,
            },
            id: "x1".into(),
            status: crate::world_model::types::OutboxStatus::Pending,
            attempts: 0,
            error_message: None,
            created_at: "2026-10-11T10:00:00.000Z".into(),
            dispatched_at: None,
            created: None,
        }
    }

    #[test]
    fn the_status_map_and_transition_validation_match_the_source() {
        assert_eq!(
            to_world_model_task_status(MissionControlTaskStatus::Review),
            TaskStatus::Waiting
        );
        assert_eq!(
            to_world_model_task_status(MissionControlTaskStatus::Done),
            TaskStatus::Completed
        );
        assert!(validate_task_transition(None, MissionControlTaskStatus::Inbox).allowed);
        let invalid = validate_task_transition(
            Some(MissionControlTaskStatus::Done),
            MissionControlTaskStatus::InProgress,
        );
        assert!(!invalid.allowed);
        assert_eq!(invalid.reason, "invalid_transition");
    }

    #[test]
    fn an_invalid_transition_is_blocking_in_required_mode() {
        let executor = RecordingExecutor::new(vec![]);
        let error = drive_sync(mirror_task_status_change(
            &executor,
            None,
            &config(WorldModelMode::Required),
            &context(MissionControlTaskStatus::InProgress),
            Some(MissionControlTaskStatus::Done),
            "2026-10-11T10:00:00.000Z",
        ))
        .expect("bridge")
        .expect_err("required blocks");
        assert_eq!(
            error.message,
            "[world-model:mission-control] invalid task transition: done -> in_progress"
        );
        assert!(executor.calls().is_empty());
    }

    #[test]
    fn an_invalid_transition_is_fail_soft_in_shadow_mode() {
        let executor = RecordingExecutor::new(vec![]);
        drive_sync(mirror_task_status_change(
            &executor,
            None,
            &config(WorldModelMode::Shadow),
            &context(MissionControlTaskStatus::InProgress),
            Some(MissionControlTaskStatus::Done),
            "2026-10-11T10:00:00.000Z",
        ))
        .expect("bridge")
        .expect("shadow swallows");
        assert!(executor.calls().is_empty());
    }

    #[test]
    fn task_creation_enqueues_the_mirror_in_a_transaction() {
        let executor =
            RecordingExecutor::new(vec![Ok(PgQueryResult::from_rows(vec![outbox_row()]))]);
        drive_sync(mirror_task_creation(
            &executor,
            None,
            &config(WorldModelMode::Shadow),
            &context(MissionControlTaskStatus::Inbox),
            "2026-10-11T10:00:00.000Z",
        ))
        .expect("bridge")
        .expect("mirror");
        let sqls: Vec<String> = executor
            .calls()
            .iter()
            .map(|call| match call {
                Recorded::Statement(statement) => statement.sql.clone(),
                Recorded::Release => "<release>".to_string(),
            })
            .collect();
        assert_eq!(sqls[0], SQL_BEGIN);
        assert!(sqls[1].contains("INSERT INTO world_model_outbox_events"));
        assert_eq!(sqls[2], SQL_COMMIT);
    }

    #[test]
    fn required_payload_string_falls_back_to_the_aggregate_id() {
        let event = outbox_event(json!({ "taskId": null }));
        assert_eq!(
            required_payload_string(&event, "taskId").expect("fallback"),
            "t1"
        );
        assert!(required_payload_string(&event, "userId").is_err());
        let named = outbox_event(json!({ "userId": "u9" }));
        assert_eq!(required_payload_string(&named, "userId").unwrap(), "u9");
    }

    #[test]
    fn an_unknown_projection_status_is_rejected() {
        let event = outbox_event(json!({ "newStatus": "bogus" }));
        let error = payload_world_model_status(&event, "newStatus").expect_err("invalid");
        assert_eq!(
            error.message,
            "[world-model:mission-control] invalid newStatus in world.task.created"
        );
        let ok = outbox_event(json!({ "newStatus": "waiting" }));
        assert_eq!(
            payload_world_model_status(&ok, "newStatus").unwrap(),
            TaskStatus::Waiting
        );
    }

    #[test]
    fn an_unprojected_task_is_reported() {
        let event = outbox_event(json!({
            "taskId": "t1", "userId": "u1", "personaId": "p1", "workspaceId": "w1",
            "newStatus": "in_progress"
        }));
        let executor = RecordingExecutor::new(vec![Ok(PgQueryResult::empty())]);
        let error = drive_sync(project_mission_control_task_status_changed(
            &executor, None, &event,
        ))
        .expect("bridge")
        .expect_err("not projected");
        assert_eq!(
            error.message,
            "[world-model:mission-control] task t1 is not projected yet"
        );
    }
}
