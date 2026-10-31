//! Port of `src/server/world-model/repositories/actionAttemptRepository.ts`
//! (136 lines) — the idempotent record of an external side effect.
//!
//! | TypeScript | Rust |
//! | --- | --- |
//! | `actionAttemptRepository.ts:4-9` (`ToolActionResult`) | [`ToolActionResult`] |
//! | `actionAttemptRepository.ts:11-18` (`ActionAttemptInput`) | [`ActionAttemptInput`] (without `scope`, see below) |
//! | `actionAttemptRepository.ts:20-33` (`ActionAttemptRecord`) | [`ActionAttemptRecord`], [`ActionAttemptStatus`] |
//! | `actionAttemptRepository.ts:35-47` (`ActionAttemptRow`) | the column names of the statements |
//! | `actionAttemptRepository.ts:49-70` (`toAttempt`) | [`to_attempt`], [`output_result`] |
//! | `actionAttemptRepository.ts:72-73` (`SELECT`) | [`SELECT_COLUMNS`] |
//! | `actionAttemptRepository.ts:81-119` (`startActionAttempt`) | [`start_action_attempt`], [`ActionAttemptStart`] |
//! | `actionAttemptRepository.ts:121-136` (`finishActionAttempt`) | [`finish_action_attempt`], [`ActionAttemptOutcome`] |
//! | `actionAttemptRepository.ts:86-91` (insert) | [`insert_sql`] |
//! | `actionAttemptRepository.ts:105-107` (conflict read) | [`existing_sql`] |
//! | `actionAttemptRepository.ts:128-133` (finish) | [`SQL_FINISH_ATTEMPT`] |
//!
//! # Scope
//!
//! `ActionAttemptInput.scope` (`:12`) is *required* in the source and is used
//! twice: it fills the `user_id`/`persona_id`/`workspace_id` columns (`:94-96`)
//! and it is the ambient RLS scope of the call site — `executeAction` wraps the
//! handler in `runWithWorldModelScope(input.scope, …)`
//! (`services/actionService.ts:38`) and passes the same object on (`:43`). The
//! port therefore takes that single scope as a required parameter and always runs
//! the statement in a scoped transaction; an unscoped variant does not exist in
//! the source, because the input cannot be built without a scope.
//! [`finish_action_attempt`] has no scope of its own (`:121-126`) and takes the
//! ambient `Option<&WorldModelScope>` of
//! [`crate::world_model::repositories`].
//!
//! # Deviations
//!
//! 1. **`status` is parsed back into the union with a fallback.** `toAttempt`
//!    types the column as the union (`:42`) and forwards whatever the row holds;
//!    a Rust enum needs a member for an out-of-union literal, and
//!    [`ActionAttemptStatus::Started`] is the state the insert itself writes.
//! 2. **`typeof output.result === 'object'` also accepts a JSON array.** The
//!    source's check is a `typeof` test (`:65`), and `typeof []` is `'object'` in
//!    JavaScript, so an array becomes a [`ToolActionResult`] with no fields
//!    instead of being dropped.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::world_model::db::{scoped_query, PgError, PgExecutor, PgRow, PgStatement, PgValue};
use crate::world_model::repositories::{
    ambient_query, normalized_scope, row_optional_text, row_text,
};
use crate::world_model::scope::WorldModelScope;

/// `ToolActionResult` from `actionAttemptRepository.ts:4-9`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolActionResult {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<String>,
    /// `payload?: unknown` — present-but-`null` and absent stay distinguishable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payload: Option<Value>,
}

/// `ActionAttemptInput` from `actionAttemptRepository.ts:11-18` without `scope`.
#[derive(Debug, Clone, PartialEq)]
pub struct ActionAttemptInput {
    pub task_id: Option<String>,
    pub action_type: String,
    pub idempotency_key: String,
    pub correlation_id: Option<String>,
    pub result: Option<ToolActionResult>,
}

/// `ActionAttemptRecord['status']` from `actionAttemptRepository.ts:27`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActionAttemptStatus {
    Started,
    Succeeded,
    Failed,
    Aborted,
}

impl ActionAttemptStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            ActionAttemptStatus::Started => "started",
            ActionAttemptStatus::Succeeded => "succeeded",
            ActionAttemptStatus::Failed => "failed",
            ActionAttemptStatus::Aborted => "aborted",
        }
    }
}

/// The `status` union of `finishActionAttempt` (`actionAttemptRepository.ts:123`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActionAttemptOutcome {
    Succeeded,
    Failed,
    Aborted,
}

impl ActionAttemptOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            ActionAttemptOutcome::Succeeded => "succeeded",
            ActionAttemptOutcome::Failed => "failed",
            ActionAttemptOutcome::Aborted => "aborted",
        }
    }
}

/// `ActionAttemptRecord` from `actionAttemptRepository.ts:20-33`.
#[derive(Debug, Clone, PartialEq)]
pub struct ActionAttemptRecord {
    pub id: String,
    pub task_id: Option<String>,
    pub user_id: String,
    pub persona_id: String,
    pub workspace_id: String,
    pub action_type: String,
    pub status: ActionAttemptStatus,
    pub idempotency_key: String,
    pub correlation_id: Option<String>,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub result: Option<ToolActionResult>,
}

/// `{ attempt, created }` from `actionAttemptRepository.ts:84`.
#[derive(Debug, Clone, PartialEq)]
pub struct ActionAttemptStart {
    pub attempt: ActionAttemptRecord,
    pub created: bool,
}

/// The `SELECT` column list of `actionAttemptRepository.ts:72-73`.
pub const SELECT_COLUMNS: &str = "id, task_id, user_id, persona_id, workspace_id, action_type, status,\n  idempotency_key, correlation_id, started_at, finished_at, output";

/// `actionAttemptRepository.ts:86-91` with `RETURNING ${SELECT}` expanded.
pub fn insert_sql() -> String {
    format!(
        "INSERT INTO world_model_action_attempts\n  (task_id, user_id, persona_id, workspace_id, action_type, status, idempotency_key, correlation_id)\nVALUES ($1,$2,$3,$4,$5,'started',$6,$7)\nON CONFLICT (user_id, persona_id, workspace_id, idempotency_key)\n  WHERE idempotency_key IS NOT NULL DO NOTHING\nRETURNING {SELECT_COLUMNS}"
    )
}

/// `actionAttemptRepository.ts:105-107` with `${SELECT}` expanded.
pub fn existing_sql() -> String {
    format!(
        "SELECT {SELECT_COLUMNS} FROM world_model_action_attempts\nWHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3 AND idempotency_key = $4\nLIMIT 1"
    )
}

/// `actionAttemptRepository.ts:128-133`.
pub const SQL_FINISH_ATTEMPT: &str = "UPDATE world_model_action_attempts\nSET status = $2, finished_at = now(),\n    output = CASE WHEN $3::jsonb IS NOT NULL\n      THEN output || jsonb_build_object('result', $3::jsonb)\n      ELSE output END\nWHERE id = $1 AND status = 'started'";

/// `actionAttemptRepository.ts:116`.
pub const ACTION_ATTEMPT_CONFLICT_MESSAGE: &str =
    "[world-model] idempotent action attempt disappeared after conflict";

/// `toAttempt(row)` — `actionAttemptRepository.ts:49-70`.
fn to_attempt(row: &PgRow) -> ActionAttemptRecord {
    ActionAttemptRecord {
        id: row_text(row, "id"),
        task_id: row_optional_text(row, "task_id"),
        user_id: row_text(row, "user_id"),
        persona_id: row_text(row, "persona_id"),
        workspace_id: row_text(row, "workspace_id"),
        action_type: row_text(row, "action_type"),
        status: status_from_column(&row_text(row, "status")),
        idempotency_key: row_text(row, "idempotency_key"),
        correlation_id: row_optional_text(row, "correlation_id"),
        started_at: row_text(row, "started_at"),
        finished_at: row_optional_text(row, "finished_at"),
        result: output_result(row),
    }
}

/// `record.result` of `actionAttemptRepository.ts:63-68`.
///
/// `row.output` has to be truthy, `output.result` has to be truthy and an
/// object; both checks are reproduced here (deviation 2).
fn output_result(row: &PgRow) -> Option<ToolActionResult> {
    let output = match row.get("output") {
        Some(Value::Object(map)) => map,
        _ => return None,
    };
    match output.get("result") {
        Some(Value::Object(map)) => Some(tool_action_result(map)),
        Some(Value::Array(_)) => Some(ToolActionResult::default()),
        _ => None,
    }
}

/// The four optional properties of a `ToolActionResult` payload.
fn tool_action_result(map: &serde_json::Map<String, Value>) -> ToolActionResult {
    let text = |key: &str| match map.get(key) {
        Some(Value::String(value)) => Some(value.clone()),
        _ => None,
    };
    ToolActionResult {
        provider_id: text("providerId"),
        target: text("target"),
        timestamp: text("timestamp"),
        payload: map.get("payload").cloned(),
    }
}

/// The `status` column of a row (deviation 1).
fn status_from_column(text: &str) -> ActionAttemptStatus {
    match text {
        "succeeded" => ActionAttemptStatus::Succeeded,
        "failed" => ActionAttemptStatus::Failed,
        "aborted" => ActionAttemptStatus::Aborted,
        _ => ActionAttemptStatus::Started,
    }
}

/// `startActionAttempt(input, db)` — `actionAttemptRepository.ts:81-119`.
///
/// The insert is the idempotent guard: a conflicting key yields no `RETURNING`
/// row, so the existing attempt is read back and returned with `created: false`.
pub async fn start_action_attempt<E: From<PgError> + Send + 'static>(
    executor: &dyn PgExecutor,
    scope: &WorldModelScope,
    input: &ActionAttemptInput,
) -> Result<ActionAttemptStart, E> {
    let parts = scope.parts();
    let result = scoped_query::<E>(
        executor,
        &normalized_scope(scope),
        PgStatement::with_params(
            insert_sql(),
            vec![
                PgValue::nullable_text(input.task_id.clone()),
                PgValue::text(parts.user_id.as_str()),
                PgValue::text(parts.persona_id.as_str()),
                PgValue::text(parts.workspace_id.as_str()),
                PgValue::text(input.action_type.as_str()),
                PgValue::text(input.idempotency_key.as_str()),
                PgValue::nullable_text(input.correlation_id.clone()),
            ],
        ),
    )
    .await?;
    if let Some(row) = result.first() {
        return Ok(ActionAttemptStart {
            attempt: to_attempt(row),
            created: true,
        });
    }

    let existing = scoped_query::<E>(
        executor,
        &normalized_scope(scope),
        PgStatement::with_params(
            existing_sql(),
            vec![
                PgValue::text(parts.user_id.as_str()),
                PgValue::text(parts.persona_id.as_str()),
                PgValue::text(parts.workspace_id.as_str()),
                PgValue::text(input.idempotency_key.as_str()),
            ],
        ),
    )
    .await?;
    match existing.first() {
        Some(row) => Ok(ActionAttemptStart {
            attempt: to_attempt(row),
            created: false,
        }),
        None => Err(E::from(PgError::new(ACTION_ATTEMPT_CONFLICT_MESSAGE))),
    }
}

/// `finishActionAttempt(id, status, result?, db)` —
/// `actionAttemptRepository.ts:121-136`.
///
/// `$3` is the JSON text of the result or `SQL NULL`; the `CASE` in the
/// statement decides whether the stored `output` is extended.
pub async fn finish_action_attempt<E: From<PgError> + Send + 'static>(
    executor: &dyn PgExecutor,
    scope: Option<&WorldModelScope>,
    id: &str,
    status: ActionAttemptOutcome,
    result: Option<&ToolActionResult>,
) -> Result<(), E> {
    ambient_query::<E>(
        executor,
        scope,
        PgStatement::with_params(
            SQL_FINISH_ATTEMPT,
            vec![
                PgValue::text(id),
                PgValue::text(status.as_str()),
                match result {
                    Some(result) => PgValue::text(
                        serde_json::to_value(result)
                            .map(|value| value.to_string())
                            .unwrap_or_else(|_| "null".to_string()),
                    ),
                    None => PgValue::Null,
                },
            ],
        ),
    )
    .await
    .map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world_model::db::testing::{Recorded, RecordingExecutor};
    use crate::world_model::db::{drive_sync, PgQueryResult, SQL_BEGIN, SQL_COMMIT, SQL_SET_SCOPE};
    use serde_json::json;

    fn scope() -> WorldModelScope {
        WorldModelScope::new("u1", "p1", Some("w1".to_string()))
    }

    fn input() -> ActionAttemptInput {
        ActionAttemptInput {
            task_id: Some("t1".to_string()),
            action_type: "send_message".to_string(),
            idempotency_key: "key-1".to_string(),
            correlation_id: None,
            result: None,
        }
    }

    fn attempt_row(status: &str, output: Value) -> PgRow {
        json!({
            "id": "a1",
            "task_id": "t1",
            "user_id": "u1",
            "persona_id": "p1",
            "workspace_id": "w1",
            "action_type": "send_message",
            "status": status,
            "idempotency_key": "key-1",
            "correlation_id": null,
            "started_at": "2026-10-10T10:00:00.000Z",
            "finished_at": null,
            "output": output,
        })
        .as_object()
        .expect("object")
        .clone()
    }

    #[test]
    fn a_start_runs_scoped_and_reads_the_result_out_of_the_output_column() {
        let executor =
            RecordingExecutor::new(vec![Ok(PgQueryResult::from_rows(vec![attempt_row(
                "started",
                json!({ "result": { "providerId": "telegram", "payload": null } }),
            )]))]);
        let started = drive_sync(start_action_attempt::<PgError>(
            &executor,
            &scope(),
            &input(),
        ))
        .expect("bridge")
        .expect("start");
        assert!(started.created);
        assert_eq!(started.attempt.id, "a1");
        assert_eq!(started.attempt.status, ActionAttemptStatus::Started);
        assert_eq!(started.attempt.task_id.as_deref(), Some("t1"));
        assert_eq!(
            started.attempt.result,
            Some(ToolActionResult {
                provider_id: Some("telegram".to_string()),
                target: None,
                timestamp: None,
                payload: Some(Value::Null),
            })
        );

        let calls = executor.calls();
        let sqls: Vec<String> = calls.iter().map(|call| call.sql().to_string()).collect();
        assert_eq!(
            sqls,
            vec![
                SQL_BEGIN.to_string(),
                SQL_SET_SCOPE.to_string(),
                insert_sql(),
                SQL_COMMIT.to_string(),
                "<release>".to_string(),
            ]
        );
        match &calls[2] {
            Recorded::Statement(statement) => assert_eq!(
                statement.params,
                vec![
                    PgValue::text("t1"),
                    PgValue::text("u1"),
                    PgValue::text("p1"),
                    PgValue::text("w1"),
                    PgValue::text("send_message"),
                    PgValue::text("key-1"),
                    PgValue::Null,
                ],
                "`taskId ?? null`, `scope.workspaceId ?? ''`, `correlationId ?? null`"
            ),
            other => panic!("expected the insert, got {other:?}"),
        }
    }

    #[test]
    fn a_start_conflict_reads_the_existing_attempt() {
        let executor = RecordingExecutor::new(vec![
            Ok(PgQueryResult::empty()),
            Ok(PgQueryResult::from_rows(vec![attempt_row(
                "started",
                Value::Null,
            )])),
        ]);
        let started = drive_sync(start_action_attempt::<PgError>(
            &executor,
            &scope(),
            &input(),
        ))
        .expect("bridge")
        .expect("start");
        assert!(!started.created);
        assert!(started.attempt.result.is_none());
        match &executor.calls()[7] {
            Recorded::Statement(statement) => {
                assert_eq!(statement.sql, existing_sql());
                assert_eq!(
                    statement.params,
                    vec![
                        PgValue::text("u1"),
                        PgValue::text("p1"),
                        PgValue::text("w1"),
                        PgValue::text("key-1"),
                    ],
                    "the conflict read repeats only the scope and the key"
                );
            }
            other => panic!("expected the conflict read, got {other:?}"),
        }
    }

    #[test]
    fn a_vanished_attempt_reports_the_source_message() {
        let executor =
            RecordingExecutor::new(vec![Ok(PgQueryResult::empty()), Ok(PgQueryResult::empty())]);
        let error = drive_sync(start_action_attempt::<PgError>(
            &executor,
            &scope(),
            &input(),
        ))
        .expect("bridge")
        .expect_err("no attempt");
        assert_eq!(
            error.message,
            "[world-model] idempotent action attempt disappeared after conflict"
        );
    }

    #[test]
    fn an_out_of_union_status_column_falls_back_to_started() {
        let executor =
            RecordingExecutor::new(vec![Ok(PgQueryResult::from_rows(vec![attempt_row(
                "not_a_status",
                Value::Null,
            )]))]);
        let started = drive_sync(start_action_attempt::<PgError>(
            &executor,
            &scope(),
            &input(),
        ))
        .expect("bridge")
        .expect("start");
        assert_eq!(
            started.attempt.status,
            ActionAttemptStatus::Started,
            "deviation 1"
        );
    }

    #[test]
    fn the_finish_statement_binds_the_serialized_result_or_null() {
        let executor = RecordingExecutor::new(vec![Ok(PgQueryResult::empty())]);
        drive_sync(finish_action_attempt::<PgError>(
            &executor,
            None,
            "a1",
            ActionAttemptOutcome::Succeeded,
            Some(&ToolActionResult {
                provider_id: Some("telegram".to_string()),
                target: None,
                timestamp: None,
                payload: Some(json!({ "messageId": 7 })),
            }),
        ))
        .expect("bridge")
        .expect("finish");
        let calls = executor.calls();
        assert_eq!(calls.len(), 1, "unscoped: no BEGIN, no scope, no COMMIT");
        match &calls[0] {
            Recorded::Statement(statement) => {
                assert_eq!(statement.sql, SQL_FINISH_ATTEMPT);
                assert_eq!(
                    statement.params,
                    vec![
                        PgValue::text("a1"),
                        PgValue::text("succeeded"),
                        PgValue::text(
                            "{\"providerId\":\"telegram\",\"payload\":{\"messageId\":7}}"
                        ),
                    ],
                    "`JSON.stringify(result)`"
                );
            }
            other => panic!("expected the finish, got {other:?}"),
        }

        let without = RecordingExecutor::new(vec![Ok(PgQueryResult::empty())]);
        drive_sync(finish_action_attempt::<PgError>(
            &without,
            Some(&scope()),
            "a1",
            ActionAttemptOutcome::Aborted,
            None,
        ))
        .expect("bridge")
        .expect("finish");
        match &without.calls()[2] {
            Recorded::Statement(statement) => assert_eq!(
                statement.params,
                vec![PgValue::text("a1"), PgValue::text("aborted"), PgValue::Null,],
                "`result ? JSON.stringify(result) : null`"
            ),
            other => panic!("expected the finish, got {other:?}"),
        }
    }
}
