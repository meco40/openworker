//! Port of `src/server/world-model/repositories/taskRepository.ts` (265 lines)
//! — the task store, its transitions and the evidence-carrying completion.
//!
//! | TypeScript | Rust |
//! | --- | --- |
//! | `taskRepository.ts:8-22` (`WorldModelTaskInput`) | [`WorldModelTaskInput`] |
//! | `taskRepository.ts:24-38` (`WorldModelTaskRecord`) | [`WorldModelTaskRecord`] |
//! | `taskRepository.ts:40-54` (`TaskRow`) | the column names of the statements and [`to_task`] |
//! | `taskRepository.ts:56-72` (`toTask`) | [`to_task`] |
//! | `taskRepository.ts:74-108` (`insertTask`) | [`insert_task`] |
//! | `taskRepository.ts:110-119` (`updateTaskStatus`) | [`update_task_status`] |
//! | `taskRepository.ts:121-159` (`completeTaskWithEvidence`) | [`complete_task_with_evidence`], [`TaskCompletionInput`] |
//! | `taskRepository.ts:161-181` (`completeTaskByTitle`) | [`complete_task_by_title`] |
//! | `taskRepository.ts:183-195` (`getTaskById`) | [`get_task_by_id`] |
//! | `taskRepository.ts:197-213` (`getTaskByExternalId`) | [`get_task_by_external_id`] |
//! | `taskRepository.ts:215-246` (`updateTaskStatusByExternalId`) | [`update_task_status_by_external_id`] |
//! | `taskRepository.ts:248-265` (`listActiveTasks`) | [`list_active_tasks`] |
//! | `taskRepository.ts:79-90` (insert) | [`SQL_INSERT_TASK`] |
//! | `taskRepository.ts:115` (status) | [`SQL_UPDATE_TASK_STATUS`] |
//! | `taskRepository.ts:132` (guard read) | [`SQL_TASK_STATUS_FOR_UPDATE`] |
//! | `taskRepository.ts:139-144` (complete) | [`SQL_COMPLETE_TASK`] |
//! | `taskRepository.ts:150-152` (transition) | [`SQL_INSERT_TASK_TRANSITION`] |
//! | `taskRepository.ts:171-174` (find by title) | [`SQL_TASK_BY_TITLE_FOR_UPDATE`] |
//! | `taskRepository.ts:188-191` (by id) | [`SQL_TASK_BY_ID`] |
//! | `taskRepository.ts:205-209` (by external id) | [`SQL_TASK_BY_EXTERNAL_ID`] |
//! | `taskRepository.ts:224-242` (mirror) | [`SQL_UPDATE_TASK_BY_EXTERNAL_ID`] |
//! | `taskRepository.ts:256-261` (active list) | [`SQL_ACTIVE_TASKS`] |
//!
//! # Transactions
//!
//! `completeTaskWithEvidence` and `completeTaskByTitle` take the `db` argument as
//! *optional* and run their statements inside `withWorldModelTransaction`
//! (`:158`, `:180`). The port reproduces that with
//! [`ambient_transaction`](crate::world_model::repositories::ambient_transaction):
//! one `BEGIN` → scope → the statements → `COMMIT`, with `ROLLBACK` and
//! `release()` on the failure path. The other functions run one statement each
//! and use the ambient `Option<&WorldModelScope>` of
//! [`crate::world_model::repositories`].
//!
//! # Deviations
//!
//! 1. **`status` is parsed back into the union with a fallback.** `toTask`
//!    forwards `row.status` (`:65`); an out-of-union literal becomes
//!    [`TaskStatus::Proposed`], the state an insert writes.
//! 2. **`completeTaskByTitle` keeps the second statement of its transaction.**
//!    The source calls `completeTaskWithEvidence(taskId, input, client)`
//!    (`:178`), which reuses the client of the running transaction; the port calls
//!    the private [`complete_task_with_evidence_in`] on the same session, so no
//!    nested `BEGIN` is issued.

use crate::world_model::db::{PgError, PgExecutor, PgRow, PgSession, PgStatement, PgValue};
use crate::world_model::repositories::{
    ambient_query, ambient_transaction, row_optional_text, row_text,
};
use crate::world_model::scope::WorldModelScope;
use crate::world_model::types::TaskStatus;

/// `WorldModelTaskInput` from `taskRepository.ts:8-22`.
#[derive(Debug, Clone, PartialEq)]
pub struct WorldModelTaskInput {
    pub user_id: String,
    pub persona_id: String,
    pub workspace_id: String,
    pub title: String,
    pub description: Option<String>,
    pub requester: Option<String>,
    pub assignee: Option<String>,
    pub external_task_id: Option<String>,
    pub origin: Option<String>,
    pub status: Option<TaskStatus>,
    pub due_at: Option<String>,
    pub idempotency_key: Option<String>,
    pub source_observation_id: Option<String>,
}

/// `WorldModelTaskRecord` from `taskRepository.ts:24-38`.
#[derive(Debug, Clone, PartialEq)]
pub struct WorldModelTaskRecord {
    pub id: String,
    pub user_id: String,
    pub persona_id: String,
    pub workspace_id: String,
    pub title: String,
    pub description: Option<String>,
    pub external_task_id: Option<String>,
    pub status: TaskStatus,
    pub due_at: Option<String>,
    pub idempotency_key: Option<String>,
    pub source_observation_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// The `input` of `completeTaskWithEvidence` (`taskRepository.ts:123-127`).
#[derive(Debug, Clone, PartialEq)]
pub struct TaskCompletionInput {
    pub source_observation_id: String,
    /// `evidence: Record<string, unknown>` — `JSON.stringify(input.evidence)`.
    pub evidence: serde_json::Map<String, serde_json::Value>,
    pub result: Option<String>,
}

/// `taskRepository.ts:79-90`.
pub const SQL_INSERT_TASK: &str = "INSERT INTO world_model_tasks\n  (user_id, persona_id, workspace_id, title, description, requester, assignee,\n  origin, external_task_id, status, due_at, idempotency_key, request_observation_id)\nVALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)\nON CONFLICT (user_id, persona_id, workspace_id, idempotency_key)\n  WHERE idempotency_key IS NOT NULL DO UPDATE SET\n    title = EXCLUDED.title, description = EXCLUDED.description,\n    requester = EXCLUDED.requester, assignee = EXCLUDED.assignee,\n    external_task_id = COALESCE(EXCLUDED.external_task_id, world_model_tasks.external_task_id),\n    updated_at = now()\nRETURNING id, user_id, persona_id, workspace_id, title, description, external_task_id, status, due_at,\n          idempotency_key, request_observation_id AS source_observation_id, created_at, updated_at";

/// `taskRepository.ts:115`.
pub const SQL_UPDATE_TASK_STATUS: &str =
    "UPDATE world_model_tasks SET status = $2, updated_at = now() WHERE id = $1";

/// `taskRepository.ts:132`.
pub const SQL_TASK_STATUS_FOR_UPDATE: &str =
    "SELECT status FROM world_model_tasks WHERE id = $1 FOR UPDATE";

/// `taskRepository.ts:139-144`.
pub const SQL_COMPLETE_TASK: &str = "UPDATE world_model_tasks\nSET status = 'completed', completion_evidence_id = $2,\n    evidence = COALESCE(evidence, '{}'::jsonb) || $3::jsonb,\n    result = COALESCE($4, result), updated_at = now()\nWHERE id = $1 AND status NOT IN ('completed', 'cancelled')\nRETURNING id";

/// `taskRepository.ts:150-152`.
pub const SQL_INSERT_TASK_TRANSITION: &str = "INSERT INTO world_model_task_transitions\n  (task_id, from_status, to_status, note, source_observation_id)\nVALUES ($1, $2, 'completed', $3, $4)";

/// `taskRepository.ts:171-174`.
pub const SQL_TASK_BY_TITLE_FOR_UPDATE: &str = "SELECT id FROM world_model_tasks\nWHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3\n  AND LOWER(title) = LOWER($4) AND status NOT IN ('completed', 'cancelled')\nORDER BY created_at ASC LIMIT 1 FOR UPDATE";

/// `taskRepository.ts:188-191`.
pub const SQL_TASK_BY_ID: &str = "SELECT id, user_id, persona_id, workspace_id, title, description, status, due_at,\n       external_task_id, idempotency_key, request_observation_id AS source_observation_id,\n       created_at, updated_at\nFROM world_model_tasks WHERE id = $1";

/// `taskRepository.ts:205-209`.
pub const SQL_TASK_BY_EXTERNAL_ID: &str = "SELECT id, user_id, persona_id, workspace_id, title, description, external_task_id, status, due_at,\n       idempotency_key, request_observation_id AS source_observation_id, created_at, updated_at\nFROM world_model_tasks\nWHERE external_task_id = $1 AND user_id = $2 AND persona_id = $3 AND workspace_id = $4\nLIMIT 1";

/// `taskRepository.ts:224-242`.
pub const SQL_UPDATE_TASK_BY_EXTERNAL_ID: &str = "WITH current_task AS (\n  SELECT id, status\n  FROM world_model_tasks\n  WHERE external_task_id = $1 AND user_id = $2 AND persona_id = $3 AND workspace_id = $4\n  LIMIT 1\n  FOR UPDATE\n), updated_task AS (\n  UPDATE world_model_tasks AS task\n  SET status = $5, updated_at = now()\n  FROM current_task\n  WHERE task.id = current_task.id AND task.status IS DISTINCT FROM $5\n  RETURNING task.id, current_task.status AS from_status, task.status AS to_status\n), transition AS (\n  INSERT INTO world_model_task_transitions (task_id, from_status, to_status, note)\n  SELECT id, from_status, to_status, 'Mission Control status mirror'\n  FROM updated_task\n  RETURNING task_id\n)\nSELECT id FROM current_task";

/// `taskRepository.ts:256-261`.
pub const SQL_ACTIVE_TASKS: &str = "SELECT id, user_id, persona_id, workspace_id, title, description, external_task_id, status, due_at,\n       idempotency_key, request_observation_id AS source_observation_id, created_at, updated_at\nFROM world_model_tasks\nWHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3\n  AND status NOT IN ('completed', 'cancelled')\nORDER BY COALESCE(due_at, created_at) ASC LIMIT $4";

/// The port's answer for a missing `RETURNING` row (`:107`).
pub const MISSING_TASK_ROW: &str = "[world-model] task insert returned no row";

/// `toTask(row)` — `taskRepository.ts:56-72`.
fn to_task(row: &PgRow) -> WorldModelTaskRecord {
    WorldModelTaskRecord {
        id: row_text(row, "id"),
        user_id: row_text(row, "user_id"),
        persona_id: row_text(row, "persona_id"),
        workspace_id: row_text(row, "workspace_id"),
        title: row_text(row, "title"),
        description: row_optional_text(row, "description"),
        external_task_id: row_optional_text(row, "external_task_id"),
        status: status_from_column(&row_text(row, "status")),
        due_at: row_optional_text(row, "due_at"),
        idempotency_key: row_optional_text(row, "idempotency_key"),
        source_observation_id: row_optional_text(row, "source_observation_id"),
        created_at: row_text(row, "created_at"),
        updated_at: row_text(row, "updated_at"),
    }
}

/// The literal of the `TaskStatus` union (`types.ts:19-26`).
fn status_literal(status: TaskStatus) -> &'static str {
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

/// The `status` column of a row (deviation 1).
fn status_from_column(text: &str) -> TaskStatus {
    match text {
        "planned" => TaskStatus::Planned,
        "in_progress" => TaskStatus::InProgress,
        "waiting" => TaskStatus::Waiting,
        "completed" => TaskStatus::Completed,
        "cancelled" => TaskStatus::Cancelled,
        "failed" => TaskStatus::Failed,
        _ => TaskStatus::Proposed,
    }
}

/// `insertTask(input, db)` — `taskRepository.ts:74-108`.
pub async fn insert_task<E: From<PgError> + Send + 'static>(
    executor: &dyn PgExecutor,
    scope: Option<&WorldModelScope>,
    input: &WorldModelTaskInput,
) -> Result<WorldModelTaskRecord, E> {
    let result = ambient_query::<E>(
        executor,
        scope,
        PgStatement::with_params(
            SQL_INSERT_TASK,
            vec![
                PgValue::text(input.user_id.as_str()),
                PgValue::text(input.persona_id.as_str()),
                PgValue::text(input.workspace_id.as_str()),
                PgValue::text(input.title.as_str()),
                PgValue::nullable_text(input.description.clone()),
                PgValue::text(
                    input
                        .requester
                        .clone()
                        .unwrap_or_else(|| input.user_id.clone()),
                ),
                PgValue::text(
                    input
                        .assignee
                        .clone()
                        .unwrap_or_else(|| input.user_id.clone()),
                ),
                PgValue::text(
                    input
                        .origin
                        .clone()
                        .unwrap_or_else(|| "mission_control".to_string()),
                ),
                PgValue::nullable_text(input.external_task_id.clone()),
                PgValue::text(status_literal(input.status.unwrap_or(TaskStatus::Proposed))),
                PgValue::nullable_text(input.due_at.clone()),
                PgValue::nullable_text(input.idempotency_key.clone()),
                PgValue::nullable_text(input.source_observation_id.clone()),
            ],
        ),
    )
    .await?;
    match result.first() {
        Some(row) => Ok(to_task(row)),
        None => Err(E::from(PgError::new(MISSING_TASK_ROW))),
    }
}

/// `updateTaskStatus(id, status, db)` — `taskRepository.ts:110-119`.
pub async fn update_task_status<E: From<PgError> + Send + 'static>(
    executor: &dyn PgExecutor,
    scope: Option<&WorldModelScope>,
    id: &str,
    status: TaskStatus,
) -> Result<(), E> {
    ambient_query::<E>(
        executor,
        scope,
        PgStatement::with_params(
            SQL_UPDATE_TASK_STATUS,
            vec![PgValue::text(id), PgValue::text(status_literal(status))],
        ),
    )
    .await
    .map(|_| ())
}

/// `completeTaskWithEvidence(id, input, db?)` — `taskRepository.ts:121-159`.
///
/// The statements of the source's `complete` callback (`:130-156`) run in one
/// transaction: the guard read with `FOR UPDATE`, the completion update and the
/// transition row. A task that is already `completed`/`cancelled` answers
/// `false` before the update, and an update that matched no row answers `false`
/// as well.
pub async fn complete_task_with_evidence<E: From<PgError> + Send + 'static>(
    executor: &dyn PgExecutor,
    scope: Option<&WorldModelScope>,
    id: &str,
    input: &TaskCompletionInput,
) -> Result<bool, E> {
    let id = id.to_string();
    let input = input.clone();
    ambient_transaction::<bool, E>(
        executor,
        scope,
        Box::new(move |session| {
            Box::pin(
                async move { complete_task_with_evidence_in(session.as_ref(), &id, &input).await },
            )
        }),
    )
    .await
}

/// The `complete` callback of `taskRepository.ts:130-156`, on the transaction's
/// own session.
pub(crate) async fn complete_task_with_evidence_in<E: From<PgError> + Send + 'static>(
    session: &dyn PgSession,
    id: &str,
    input: &TaskCompletionInput,
) -> Result<bool, E> {
    let current = session
        .query(PgStatement::with_params(
            SQL_TASK_STATUS_FOR_UPDATE,
            vec![PgValue::text(id)],
        ))
        .await
        .map_err(E::from)?;
    let from_status = match current.first() {
        Some(row) => row_text(row, "status"),
        None => return Ok(false),
    };
    if from_status == "completed" || from_status == "cancelled" {
        return Ok(false);
    }

    let updated = session
        .query(PgStatement::with_params(
            SQL_COMPLETE_TASK,
            vec![
                PgValue::text(id),
                PgValue::text(input.source_observation_id.as_str()),
                PgValue::text(serde_json::Value::Object(input.evidence.clone()).to_string()),
                PgValue::nullable_text(input.result.clone()),
            ],
        ))
        .await
        .map_err(E::from)?;
    if updated.first().is_none() {
        return Ok(false);
    }

    session
        .query(PgStatement::with_params(
            SQL_INSERT_TASK_TRANSITION,
            vec![
                PgValue::text(id),
                PgValue::text(from_status),
                PgValue::text("Completion evidence recorded"),
                PgValue::text(input.source_observation_id.as_str()),
            ],
        ))
        .await
        .map_err(E::from)?;
    Ok(true)
}

/// `completeTaskByTitle(userId, personaId, workspaceId, title, input, db?)` —
/// `taskRepository.ts:161-181`.
pub async fn complete_task_by_title<E: From<PgError> + Send + 'static>(
    executor: &dyn PgExecutor,
    scope: Option<&WorldModelScope>,
    user_id: &str,
    persona_id: &str,
    workspace_id: &str,
    title: &str,
    input: &TaskCompletionInput,
) -> Result<bool, E> {
    let (user_id, persona_id, workspace_id, title, input) = (
        user_id.to_string(),
        persona_id.to_string(),
        workspace_id.to_string(),
        title.to_string(),
        input.clone(),
    );
    ambient_transaction::<bool, E>(
        executor,
        scope,
        Box::new(move |session| {
            Box::pin(async move {
                let result = session
                    .query(PgStatement::with_params(
                        SQL_TASK_BY_TITLE_FOR_UPDATE,
                        vec![
                            PgValue::text(user_id.as_str()),
                            PgValue::text(persona_id.as_str()),
                            PgValue::text(workspace_id.as_str()),
                            PgValue::text(title.as_str()),
                        ],
                    ))
                    .await
                    .map_err(E::from)?;
                match result.first() {
                    Some(row) => {
                        let task_id = row_text(row, "id");
                        complete_task_with_evidence_in(session.as_ref(), &task_id, &input).await
                    }
                    None => Ok(false),
                }
            })
        }),
    )
    .await
}

/// `getTaskById(id, db)` — `taskRepository.ts:183-195`.
pub async fn get_task_by_id<E: From<PgError> + Send + 'static>(
    executor: &dyn PgExecutor,
    scope: Option<&WorldModelScope>,
    id: &str,
) -> Result<Option<WorldModelTaskRecord>, E> {
    let result = ambient_query::<E>(
        executor,
        scope,
        PgStatement::with_params(SQL_TASK_BY_ID, vec![PgValue::text(id)]),
    )
    .await?;
    Ok(result.first().map(to_task))
}

/// `getTaskByExternalId(externalTaskId, userId, personaId, workspaceId, db)` —
/// `taskRepository.ts:197-213`.
pub async fn get_task_by_external_id<E: From<PgError> + Send + 'static>(
    executor: &dyn PgExecutor,
    scope: Option<&WorldModelScope>,
    external_task_id: &str,
    user_id: &str,
    persona_id: &str,
    workspace_id: &str,
) -> Result<Option<WorldModelTaskRecord>, E> {
    let result = ambient_query::<E>(
        executor,
        scope,
        PgStatement::with_params(
            SQL_TASK_BY_EXTERNAL_ID,
            vec![
                PgValue::text(external_task_id),
                PgValue::text(user_id),
                PgValue::text(persona_id),
                PgValue::text(workspace_id),
            ],
        ),
    )
    .await?;
    Ok(result.first().map(to_task))
}

/// `updateTaskStatusByExternalId(externalTaskId, userId, personaId, workspaceId,
/// status, db)` — `taskRepository.ts:215-246`.
///
/// Answers `result.rows.length > 0`: the statement returns the mirrored task id
/// only when the task existed, and the `IS DISTINCT FROM` guard skips the
/// transition insert for an unchanged status.
pub async fn update_task_status_by_external_id<E: From<PgError> + Send + 'static>(
    executor: &dyn PgExecutor,
    scope: Option<&WorldModelScope>,
    external_task_id: &str,
    user_id: &str,
    persona_id: &str,
    workspace_id: &str,
    status: TaskStatus,
) -> Result<bool, E> {
    let result = ambient_query::<E>(
        executor,
        scope,
        PgStatement::with_params(
            SQL_UPDATE_TASK_BY_EXTERNAL_ID,
            vec![
                PgValue::text(external_task_id),
                PgValue::text(user_id),
                PgValue::text(persona_id),
                PgValue::text(workspace_id),
                PgValue::text(status_literal(status)),
            ],
        ),
    )
    .await?;
    Ok(!result.rows.is_empty())
}

/// `listActiveTasks(userId, personaId, workspaceId, limit = 50, db)` —
/// `taskRepository.ts:248-265`.
pub async fn list_active_tasks<E: From<PgError> + Send + 'static>(
    executor: &dyn PgExecutor,
    scope: Option<&WorldModelScope>,
    user_id: &str,
    persona_id: &str,
    workspace_id: &str,
    limit: Option<i64>,
) -> Result<Vec<WorldModelTaskRecord>, E> {
    let result = ambient_query::<E>(
        executor,
        scope,
        PgStatement::with_params(
            SQL_ACTIVE_TASKS,
            vec![
                PgValue::text(user_id),
                PgValue::text(persona_id),
                PgValue::text(workspace_id),
                PgValue::Int64(limit.unwrap_or(50)),
            ],
        ),
    )
    .await?;
    Ok(result.rows.iter().map(to_task).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world_model::db::testing::RecordingExecutor;
    use crate::world_model::db::{drive_sync, PgQueryResult, SQL_BEGIN, SQL_COMMIT, SQL_SET_SCOPE};
    use serde_json::json;

    fn scope() -> WorldModelScope {
        WorldModelScope::new("u1", "p1", Some("w1".to_string()))
    }

    fn task_input() -> WorldModelTaskInput {
        WorldModelTaskInput {
            user_id: "u1".to_string(),
            persona_id: "p1".to_string(),
            workspace_id: "w1".to_string(),
            title: "Book the room".to_string(),
            description: None,
            requester: None,
            assignee: None,
            external_task_id: None,
            origin: None,
            status: None,
            due_at: None,
            idempotency_key: None,
            source_observation_id: None,
        }
    }

    fn completion() -> TaskCompletionInput {
        TaskCompletionInput {
            source_observation_id: "o1".to_string(),
            evidence: serde_json::from_value(json!({"messageSeq":7,"text":"Booked"})).unwrap(),
            result: Some("Booked".into()),
        }
    }

    fn task_row() -> PgRow {
        json!({
            "id": "t1",
            "user_id": "u1",
            "persona_id": "p1",
            "workspace_id": "w1",
            "title": "Book the room",
            "description": null,
            "external_task_id": null,
            "status": "proposed",
            "due_at": null,
            "idempotency_key": null,
            "source_observation_id": null,
            "created_at": "2026-10-10T10:00:00.000Z",
            "updated_at": "2026-10-10T10:00:00.000Z",
        })
        .as_object()
        .expect("object")
        .clone()
    }

    fn as_record_row(value: serde_json::Value) -> PgRow {
        value.as_object().expect("object").clone()
    }

    #[test]
    fn an_insert_binds_the_mission_control_defaults() {
        let executor = RecordingExecutor::new(vec![Ok(PgQueryResult::from_rows(vec![task_row()]))]);
        let task = drive_sync(insert_task::<PgError>(
            &executor,
            Some(&scope()),
            &task_input(),
        ))
        .expect("bridge")
        .expect("insert");
        assert_eq!(task.id, "t1");
        assert_eq!(task.status, TaskStatus::Proposed);
        let sqls: Vec<String> = executor
            .calls()
            .iter()
            .map(|call| call.sql().to_string())
            .collect();
        assert_eq!(
            sqls,
            vec![
                SQL_BEGIN.to_string(),
                SQL_SET_SCOPE.to_string(),
                SQL_INSERT_TASK.to_string(),
                SQL_COMMIT.to_string(),
                "<release>".to_string(),
            ]
        );
        match &executor.calls()[2] {
            crate::world_model::db::testing::Recorded::Statement(statement) => assert_eq!(
                statement.params,
                vec![
                    PgValue::text("u1"),
                    PgValue::text("p1"),
                    PgValue::text("w1"),
                    PgValue::text("Book the room"),
                    PgValue::Null,
                    PgValue::text("u1"),
                    PgValue::text("u1"),
                    PgValue::text("mission_control"),
                    PgValue::Null,
                    PgValue::text("proposed"),
                    PgValue::Null,
                    PgValue::Null,
                    PgValue::Null,
                ],
                "`requester ?? userId`, `assignee ?? userId`, `origin ?? 'mission_control'`, \
                 `status ?? 'proposed'`"
            ),
            other => panic!("expected the insert, got {other:?}"),
        }
    }

    #[test]
    fn evidence_completion_locks_updates_and_records_a_transition_atomically() {
        let executor = RecordingExecutor::new(vec![
            Ok(PgQueryResult::from_rows(vec![as_record_row(
                json!({"status":"in_progress"}),
            )])),
            Ok(PgQueryResult::from_rows(vec![as_record_row(
                json!({"id":"t1"}),
            )])),
            Ok(PgQueryResult::empty()),
        ]);
        assert!(drive_sync(complete_task_with_evidence::<PgError>(
            &executor,
            Some(&scope()),
            "t1",
            &completion()
        ))
        .unwrap()
        .unwrap());
        let sqls = executor
            .calls()
            .iter()
            .map(|call| call.sql().to_string())
            .collect::<Vec<_>>();
        assert_eq!(
            sqls,
            [
                SQL_BEGIN.to_string(),
                SQL_SET_SCOPE.to_string(),
                SQL_TASK_STATUS_FOR_UPDATE.to_string(),
                SQL_COMPLETE_TASK.to_string(),
                SQL_INSERT_TASK_TRANSITION.to_string(),
                SQL_COMMIT.to_string(),
                "<release>".to_string(),
            ]
        );
        match &executor.calls()[3] {
            crate::world_model::db::testing::Recorded::Statement(statement) => {
                assert_eq!(statement.params[0], PgValue::text("t1"));
                assert_eq!(
                    statement.params[2],
                    PgValue::text(r#"{"messageSeq":7,"text":"Booked"}"#)
                );
            }
            other => panic!("expected completion update, got {other:?}"),
        }
    }
}
