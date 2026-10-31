//! Port of `src/server/world-model/repositories/outboxRepository.ts`
//! (154 lines) — the transactional outbox of the slice.
//!
//! | TypeScript | Rust |
//! | --- | --- |
//! | `outboxRepository.ts:4-21` (`OutboxRow`) | the column names of the statements, [`row_boolean`](crate::world_model::repositories::row_boolean) for `inserted` |
//! | `outboxRepository.ts:23-42` (`toOutboxEvent`) | [`to_outbox_event`] |
//! | `outboxRepository.ts:44-71` (`enqueueOutboxEvent`) | [`enqueue_outbox_event`] |
//! | `outboxRepository.ts:73-85` (`listPendingOutboxEvents`) | [`list_pending_outbox_events`] |
//! | `outboxRepository.ts:87-115` (`claimPendingOutboxEvents`) | [`claim_pending_outbox_events`] |
//! | `outboxRepository.ts:117-125` (`markOutboxDispatched`) | [`mark_outbox_dispatched`] |
//! | `outboxRepository.ts:127-144` (`markOutboxFailed`) | [`mark_outbox_failed`] |
//! | `outboxRepository.ts:146-154` (`resetFailedOutboxEvents`) | [`reset_failed_outbox_events`] |
//! | `outboxRepository.ts:49-57` (enqueue) | [`SQL_ENQUEUE_OUTBOX`] |
//! | `outboxRepository.ts:76-81` (pending list) | [`SQL_PENDING_OUTBOX`] |
//! | `outboxRepository.ts:95-111` (claim) | [`SQL_CLAIM_OUTBOX`] |
//! | `outboxRepository.ts:120-122` (dispatched) | [`SQL_MARK_DISPATCHED`] |
//! | `outboxRepository.ts:134-141` (failed) | [`SQL_MARK_OUTBOX_FAILED`] |
//! | `outboxRepository.ts:149-151` (reset) | [`SQL_RESET_FAILED_OUTBOX`] |
//!
//! # The unscoped dispatcher path
//!
//! Every function of this file is reached both ways in the source:
//! `dispatchOutboxOnce` runs the claim and the two marks without a scope
//! (`outboxDispatcher.ts:60-78`), and `dispatchOutboxOnceInScope` wraps exactly
//! that call in `runWithWorldModelScope` (`:88-93`). The port therefore takes the
//! ambient scope as `Option<&WorldModelScope>` for all of them: `None` is the
//! bare `pool.query` of `db.ts:109`, which is the RLS policy's
//! `NOT world_model_is_scoped_session()` branch
//! (`006_rls_and_runtime_roles.sql:106`) — the only way the worker role can see
//! the rows it has to claim.
//!
//! # Deviations
//!
//! 1. **`errorMessage.slice(0, 2000)` counts UTF-16 code units** (see
//!    [`truncate_message`]).
//! 2. **`String(payload.userId)` for a non-string payload value.** The source
//!    stringifies whatever the payload holds; the port stringifies numbers and
//!    booleans the same way and writes a JSON object/array in its compact form,
//!    where JavaScript would write `"[object Object]"`. No producer of this slice
//!    puts an object into `payload.userId`/`personaId`/`workspaceId`.
//! 3. **A missing `RETURNING` row is an error instead of a `TypeError`.** The
//!    source reads `result.rows[0]` (`:70`); the port answers
//!    [`MISSING_OUTBOX_ROW`].

use serde_json::Value;

use crate::world_model::db::{PgError, PgExecutor, PgRow, PgStatement, PgValue};
use crate::world_model::repositories::{
    ambient_query, row_boolean, row_integer, row_object, row_optional_text, row_text,
};
use crate::world_model::scope::WorldModelScope;
use crate::world_model::types::{OutboxEvent, OutboxEventInput, OutboxStatus};

/// `outboxRepository.ts:49-57`.
pub const SQL_ENQUEUE_OUTBOX: &str = "INSERT INTO world_model_outbox_events\n  (event_type, aggregate_type, aggregate_id, payload, idempotency_key, correlation_id,\n   user_id, persona_id, workspace_id)\nVALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)\nON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL\n  DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key\nRETURNING id, event_type, aggregate_type, aggregate_id, payload, status, attempts,\n          error_message, created_at, dispatched_at, idempotency_key, correlation_id,\n          user_id, persona_id, workspace_id, (xmax = 0) AS inserted";

/// `outboxRepository.ts:76-81`.
pub const SQL_PENDING_OUTBOX: &str = "SELECT id, event_type, aggregate_type, aggregate_id, payload, status, attempts,\n       error_message, created_at, dispatched_at\nFROM world_model_outbox_events\nWHERE status IN ('pending','failed') AND next_attempt_at <= now()\n  AND (locked_until IS NULL OR locked_until <= now())\nORDER BY created_at ASC LIMIT $1";

/// `outboxRepository.ts:95-111`.
pub const SQL_CLAIM_OUTBOX: &str = "WITH candidates AS (\n  SELECT id\n  FROM world_model_outbox_events\n  WHERE status IN ('pending','failed') AND next_attempt_at <= now()\n    AND (locked_until IS NULL OR locked_until <= now())\n    AND (cardinality($4::text[]) = 0 OR event_type = ANY($4::text[]))\n  ORDER BY created_at ASC, id ASC\n  FOR UPDATE SKIP LOCKED\n  LIMIT $1\n)\nUPDATE world_model_outbox_events AS events\nSET locked_by = $2, locked_until = now() + ($3 * interval '1 millisecond')\nFROM candidates\nWHERE events.id = candidates.id\nRETURNING events.id, events.event_type, events.aggregate_type, events.aggregate_id,\n          events.payload, events.status, events.attempts, events.error_message,\n          events.created_at, events.dispatched_at";

/// `outboxRepository.ts:120-122`.
pub const SQL_MARK_DISPATCHED: &str = "UPDATE world_model_outbox_events SET status = 'dispatched', dispatched_at = now(),\n  error_message = NULL, locked_by = NULL, locked_until = NULL\nWHERE id = $1 AND ($2::text IS NULL OR locked_by = $2)";

/// `outboxRepository.ts:134-141`.
pub const SQL_MARK_OUTBOX_FAILED: &str = "UPDATE world_model_outbox_events SET attempts = attempts + 1, error_message = $2,\n   next_attempt_at = now() + (LEAST(300000, 1000 * power(2, attempts + 1)) * interval '1 millisecond'),\n   locked_by = NULL, locked_until = NULL,\n   status = CASE\n     WHEN attempts + 1 >= 5 THEN 'permanent_failure'::world_model_outbox_status\n     ELSE 'failed'::world_model_outbox_status\n   END\nWHERE id = $1 AND ($3::text IS NULL OR locked_by = $3)";

/// `outboxRepository.ts:149-151`.
pub const SQL_RESET_FAILED_OUTBOX: &str = "UPDATE world_model_outbox_events SET status = 'pending', error_message = NULL,\n   next_attempt_at = now(), locked_by = NULL, locked_until = NULL\nWHERE status = 'failed'";

/// The port's answer for `result.rows[0]` being absent (`:70`) — deviation 3.
pub const MISSING_OUTBOX_ROW: &str = "[world-model] outbox enqueue returned no row";

/// `toOutboxEvent(row)` — `outboxRepository.ts:23-42`.
///
/// The optional scope columns and `inserted` are absent from the list and claim
/// projections (`:76-81`, `:109-111`), so they become `None`/`undefined` there
/// exactly like the source's `?? undefined`.
fn to_outbox_event(row: &PgRow) -> OutboxEvent {
    OutboxEvent {
        input: OutboxEventInput {
            event_type: row_text(row, "event_type"),
            aggregate_type: row_text(row, "aggregate_type"),
            aggregate_id: row_text(row, "aggregate_id"),
            payload: row_object(row, "payload"),
            idempotency_key: row_optional_text(row, "idempotency_key"),
            correlation_id: row_optional_text(row, "correlation_id"),
            user_id: row_optional_text(row, "user_id"),
            persona_id: row_optional_text(row, "persona_id"),
            workspace_id: row_optional_text(row, "workspace_id"),
        },
        id: row_text(row, "id"),
        status: status_from_column(&row_text(row, "status")),
        attempts: row_integer(row, "attempts"),
        error_message: row_optional_text(row, "error_message"),
        created_at: row_text(row, "created_at"),
        dispatched_at: row_optional_text(row, "dispatched_at"),
        created: row_boolean(row, "inserted"),
    }
}

/// The `status` column of a row; an out-of-union literal falls back to
/// [`OutboxStatus::Pending`], the state an enqueue writes.
fn status_from_column(text: &str) -> OutboxStatus {
    match text {
        "dispatched" => OutboxStatus::Dispatched,
        "failed" => OutboxStatus::Failed,
        "permanent_failure" => OutboxStatus::PermanentFailure,
        _ => OutboxStatus::Pending,
    }
}

/// JavaScript truthiness of a payload property
/// (`input.payload?.userId ? … : …`, `outboxRepository.ts:65-67`).
fn js_truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().map(|value| value != 0.0).unwrap_or(false),
        Some(Value::String(text)) => !text.is_empty(),
        // An object or an array is always truthy, even an empty one.
        Some(_) => true,
    }
}

/// `String(value)` of the payload fallback (deviation 2).
fn js_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => number.to_string(),
        other => other.to_string(),
    }
}

/// `errorMessage.slice(0, 2000)` — `outboxRepository.ts:142` (deviation 1).
fn truncate_message(text: &str) -> String {
    let mut units = 0usize;
    let mut out = String::new();
    for character in text.chars() {
        let width = character.len_utf16();
        if units + width > 2000 {
            break;
        }
        units += width;
        out.push(character);
    }
    out
}

/// `enqueueOutboxEvent(input, db)` — `outboxRepository.ts:44-71`.
///
/// The conflict target is the *idempotency key* and the `DO UPDATE` writes the
/// key back, so a retry of the same key returns the stored row unchanged and
/// `(xmax = 0) AS inserted` tells the caller whether it created it.
pub async fn enqueue_outbox_event<E: From<PgError> + Send + 'static>(
    executor: &dyn PgExecutor,
    scope: Option<&WorldModelScope>,
    input: &OutboxEventInput,
) -> Result<OutboxEvent, E> {
    let payload_value = |key: &str| input.payload.get(key);
    let payload_text = |key: &str| {
        payload_value(key)
            .filter(|value| js_truthy(Some(value)))
            .map(js_string)
    };
    let result = ambient_query::<E>(
        executor,
        scope,
        PgStatement::with_params(
            SQL_ENQUEUE_OUTBOX,
            vec![
                PgValue::text(input.event_type.as_str()),
                PgValue::text(input.aggregate_type.as_str()),
                PgValue::text(input.aggregate_id.as_str()),
                PgValue::text(Value::Object(input.payload.clone()).to_string()),
                PgValue::nullable_text(input.idempotency_key.clone()),
                PgValue::nullable_text(input.correlation_id.clone()),
                PgValue::nullable_text(input.user_id.clone().or_else(|| payload_text("userId"))),
                PgValue::nullable_text(
                    input
                        .persona_id
                        .clone()
                        .or_else(|| payload_text("personaId")),
                ),
                PgValue::text(
                    input
                        .workspace_id
                        .clone()
                        .or_else(|| payload_text("workspaceId"))
                        .unwrap_or_default(),
                ),
            ],
        ),
    )
    .await?;
    match result.first() {
        Some(row) => Ok(to_outbox_event(row)),
        None => Err(E::from(PgError::new(MISSING_OUTBOX_ROW))),
    }
}

/// `listPendingOutboxEvents(limit)` — `outboxRepository.ts:73-85`.
pub async fn list_pending_outbox_events<E: From<PgError> + Send + 'static>(
    executor: &dyn PgExecutor,
    scope: Option<&WorldModelScope>,
    limit: i64,
) -> Result<Vec<OutboxEvent>, E> {
    let result = ambient_query::<E>(
        executor,
        scope,
        PgStatement::with_params(SQL_PENDING_OUTBOX, vec![PgValue::Int64(limit)]),
    )
    .await?;
    Ok(result.rows.iter().map(to_outbox_event).collect())
}

/// `claimPendingOutboxEvents(limit, workerId, leaseMs = 60000, eventTypes = [])`
/// — `outboxRepository.ts:87-115`.
///
/// `leaseMs` is the millisecond count that is added to `now()` inside the
/// statement (`$3 * interval '1 millisecond'`), and an empty `eventTypes` list
/// means "every event type" (`cardinality($4::text[]) = 0`).
pub async fn claim_pending_outbox_events<E: From<PgError> + Send + 'static>(
    executor: &dyn PgExecutor,
    scope: Option<&WorldModelScope>,
    limit: i64,
    worker_id: &str,
    lease_ms: Option<i64>,
    event_types: Option<Vec<String>>,
) -> Result<Vec<OutboxEvent>, E> {
    let result = ambient_query::<E>(
        executor,
        scope,
        PgStatement::with_params(
            SQL_CLAIM_OUTBOX,
            vec![
                PgValue::Int64(limit),
                PgValue::text(worker_id),
                PgValue::Int64(lease_ms.unwrap_or(60_000)),
                PgValue::text_array(event_types.unwrap_or_default()),
            ],
        ),
    )
    .await?;
    Ok(result.rows.iter().map(to_outbox_event).collect())
}

/// `markOutboxDispatched(id, workerId?)` — `outboxRepository.ts:117-125`.
///
/// `$2::text IS NULL OR locked_by = $2`: the guard makes the update a no-op when
/// another worker holds the lease.
pub async fn mark_outbox_dispatched<E: From<PgError> + Send + 'static>(
    executor: &dyn PgExecutor,
    scope: Option<&WorldModelScope>,
    id: &str,
    worker_id: Option<&str>,
) -> Result<(), E> {
    ambient_query::<E>(
        executor,
        scope,
        PgStatement::with_params(
            SQL_MARK_DISPATCHED,
            vec![
                PgValue::text(id),
                PgValue::nullable_text(worker_id.map(str::to_string)),
            ],
        ),
    )
    .await
    .map(|_| ())
}

/// `markOutboxFailed(id, errorMessage, workerId?)` —
/// `outboxRepository.ts:127-144`.
///
/// The message is cut to 2000 code units (`:142`) and the `CASE` promotes the
/// event to `permanent_failure` from the fifth attempt on.
pub async fn mark_outbox_failed<E: From<PgError> + Send + 'static>(
    executor: &dyn PgExecutor,
    scope: Option<&WorldModelScope>,
    id: &str,
    error_message: &str,
    worker_id: Option<&str>,
) -> Result<(), E> {
    ambient_query::<E>(
        executor,
        scope,
        PgStatement::with_params(
            SQL_MARK_OUTBOX_FAILED,
            vec![
                PgValue::text(id),
                PgValue::text(truncate_message(error_message)),
                PgValue::nullable_text(worker_id.map(str::to_string)),
            ],
        ),
    )
    .await
    .map(|_| ())
}

/// `resetFailedOutboxEvents()` — `outboxRepository.ts:146-154`.
///
/// Answers `result.rowCount ?? 0`, the number of re-queued events.
pub async fn reset_failed_outbox_events<E: From<PgError> + Send + 'static>(
    executor: &dyn PgExecutor,
    scope: Option<&WorldModelScope>,
) -> Result<i64, E> {
    let result =
        ambient_query::<E>(executor, scope, PgStatement::new(SQL_RESET_FAILED_OUTBOX)).await?;
    Ok(result.row_count)
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

    fn event_input() -> OutboxEventInput {
        OutboxEventInput {
            event_type: "world.observation.created".to_string(),
            aggregate_type: "observation".to_string(),
            aggregate_id: "o1".to_string(),
            payload: serde_json::Map::new(),
            idempotency_key: Some("key-1".to_string()),
            correlation_id: None,
            user_id: None,
            persona_id: None,
            workspace_id: None,
        }
    }

    fn outbox_row() -> PgRow {
        json!({
            "id": "e1",
            "event_type": "world.observation.created",
            "aggregate_type": "observation",
            "aggregate_id": "o1",
            "payload": { "userId": "u1" },
            "status": "pending",
            "attempts": 0,
            "error_message": null,
            "created_at": "2026-10-10T10:00:00.000Z",
            "dispatched_at": null,
            "idempotency_key": "key-1",
            "correlation_id": null,
            "user_id": "u1",
            "persona_id": null,
            "workspace_id": "",
            "inserted": true,
        })
        .as_object()
        .expect("object")
        .clone()
    }

    fn claim_row() -> PgRow {
        json!({
            "id": "e1",
            "event_type": "world.observation.created",
            "aggregate_type": "observation",
            "aggregate_id": "o1",
            "payload": {},
            "status": "pending",
            "attempts": 1,
            "error_message": null,
            "created_at": "2026-10-10T10:00:00.000Z",
            "dispatched_at": null,
        })
        .as_object()
        .expect("object")
        .clone()
    }

    #[test]
    fn an_enqueue_falls_back_to_the_scope_properties_of_the_payload() {
        let executor =
            RecordingExecutor::new(vec![Ok(PgQueryResult::from_rows(vec![outbox_row()]))]);
        let mut input = event_input();
        input.payload.insert("userId".to_string(), json!("u1"));
        input.payload.insert("personaId".to_string(), json!("p1"));
        input.payload.insert("workspaceId".to_string(), json!("w1"));
        let event = drive_sync(enqueue_outbox_event::<PgError>(
            &executor,
            Some(&scope()),
            &input,
        ))
        .expect("bridge")
        .expect("enqueue");
        assert_eq!(event.id, "e1");
        assert_eq!(event.status, OutboxStatus::Pending);
        assert_eq!(event.created, Some(true), "`(xmax = 0) AS inserted`");
        assert_eq!(event.input.user_id.as_deref(), Some("u1"));
        assert_eq!(event.error_message, None);
        let sqls: Vec<String> = executor
            .calls()
            .iter()
            .filter(|call| !matches!(call, Recorded::Release))
            .map(|call| call.sql().to_string())
            .collect();
        assert_eq!(
            sqls,
            vec![
                SQL_BEGIN.to_string(),
                SQL_SET_SCOPE.to_string(),
                SQL_ENQUEUE_OUTBOX.to_string(),
                SQL_COMMIT.to_string(),
            ]
        );
        match &executor.calls()[2] {
            Recorded::Statement(statement) => assert_eq!(
                statement.params,
                vec![
                    PgValue::text("world.observation.created"),
                    PgValue::text("observation"),
                    PgValue::text("o1"),
                    PgValue::text(
                        "{\"userId\":\"u1\",\"personaId\":\"p1\",\"workspaceId\":\"w1\"}"
                    ),
                    PgValue::text("key-1"),
                    PgValue::Null,
                    PgValue::text("u1"),
                    PgValue::text("p1"),
                    PgValue::text("w1"),
                ],
                "`userId ?? (payload.userId ? String(payload.userId) : null)` and its siblings"
            ),
            other => panic!("expected the enqueue, got {other:?}"),
        }
    }

    #[test]
    fn an_unscoped_dispatch_batch_stays_on_the_pool() {
        let executor =
            RecordingExecutor::new(vec![Ok(PgQueryResult::from_rows(vec![claim_row()]))]);
        let claimed = drive_sync(claim_pending_outbox_events::<PgError>(
            &executor, None, 10, "worker-1", None, None,
        ))
        .expect("bridge")
        .expect("claim");
        assert_eq!(claimed.len(), 1);
        assert_eq!(
            claimed[0].created, None,
            "the claim projection has no `inserted` column"
        );
        assert_eq!(claimed[0].attempts, 1);
        let calls = executor.calls();
        assert_eq!(
            calls.len(),
            1,
            "`dispatchOutboxOnce` has no scope: one bare pool query"
        );
        match &calls[0] {
            Recorded::Statement(statement) => {
                assert_eq!(statement.sql, SQL_CLAIM_OUTBOX);
                assert_eq!(
                    statement.params,
                    vec![
                        PgValue::Int64(10),
                        PgValue::text("worker-1"),
                        PgValue::Int64(60_000),
                        PgValue::text_array(Vec::new()),
                    ],
                    "`leaseMs = 60_000` and `eventTypes: string[] = []`"
                );
            }
            other => panic!("expected the claim, got {other:?}"),
        }

        let scoped = RecordingExecutor::new(vec![Ok(PgQueryResult::empty())]);
        drive_sync(claim_pending_outbox_events::<PgError>(
            &scoped,
            Some(&scope()),
            5,
            "worker-2",
            Some(1_000),
            Some(vec!["world.task.created".to_string()]),
        ))
        .expect("bridge")
        .expect("claim");
        match &scoped.calls()[2] {
            Recorded::Statement(statement) => assert_eq!(
                statement.params,
                vec![
                    PgValue::Int64(5),
                    PgValue::text("worker-2"),
                    PgValue::Int64(1_000),
                    PgValue::text_array(vec!["world.task.created".to_string()]),
                ],
                "`$4::text[]` carries the event-type filter"
            ),
            other => panic!("expected the claim, got {other:?}"),
        }
    }

    #[test]
    fn the_pending_list_and_the_two_marks_bind_their_parameters() {
        let pending = RecordingExecutor::new(vec![Ok(PgQueryResult::from_rows(vec![claim_row()]))]);
        let events = drive_sync(list_pending_outbox_events::<PgError>(&pending, None, 25))
            .expect("bridge")
            .expect("list");
        assert_eq!(events.len(), 1);
        match &pending.calls()[0] {
            Recorded::Statement(statement) => {
                assert_eq!(statement.sql, SQL_PENDING_OUTBOX);
                assert_eq!(statement.params, vec![PgValue::Int64(25)]);
            }
            other => panic!("expected the pending list, got {other:?}"),
        }

        let dispatched = RecordingExecutor::new(vec![Ok(PgQueryResult::affected(1))]);
        drive_sync(mark_outbox_dispatched::<PgError>(
            &dispatched,
            Some(&scope()),
            "e1",
            Some("worker-1"),
        ))
        .expect("bridge")
        .expect("mark");
        match &dispatched.calls()[2] {
            Recorded::Statement(statement) => {
                assert_eq!(statement.sql, SQL_MARK_DISPATCHED);
                assert_eq!(
                    statement.params,
                    vec![PgValue::text("e1"), PgValue::text("worker-1")]
                );
            }
            other => panic!("expected the dispatch mark, got {other:?}"),
        }

        let failed = RecordingExecutor::new(vec![Ok(PgQueryResult::affected(1))]);
        drive_sync(mark_outbox_failed::<PgError>(
            &failed,
            None,
            "e1",
            &"f".repeat(2001),
            None,
        ))
        .expect("bridge")
        .expect("mark");
        match &failed.calls()[0] {
            Recorded::Statement(statement) => {
                assert_eq!(statement.sql, SQL_MARK_OUTBOX_FAILED);
                assert_eq!(
                    statement.params,
                    vec![
                        PgValue::text("e1"),
                        PgValue::text("f".repeat(2000)),
                        PgValue::Null,
                    ],
                    "`errorMessage.slice(0, 2000)` and `workerId ?? null`"
                );
            }
            other => panic!("expected the failure mark, got {other:?}"),
        }
    }

    #[test]
    fn the_reset_answers_the_affected_row_count() {
        let executor = RecordingExecutor::new(vec![Ok(PgQueryResult::affected(4))]);
        let count = drive_sync(reset_failed_outbox_events::<PgError>(&executor, None))
            .expect("bridge")
            .expect("reset");
        assert_eq!(count, 4);
        match &executor.calls()[0] {
            Recorded::Statement(statement) => {
                assert_eq!(statement.sql, SQL_RESET_FAILED_OUTBOX);
                assert!(statement.params.is_empty());
            }
            other => panic!("expected the reset, got {other:?}"),
        }
    }

    #[test]
    fn the_payload_fallback_follows_javascript_truthiness() {
        assert!(!js_truthy(None));
        assert!(!js_truthy(Some(&Value::Null)));
        assert!(!js_truthy(Some(&json!(""))));
        assert!(!js_truthy(Some(&json!(0))));
        assert!(js_truthy(Some(&json!("u1"))));
        assert!(js_truthy(Some(&json!({}))), "an object is always truthy");
        assert_eq!(js_string(&json!(7)), "7");
        assert_eq!(js_string(&json!(true)), "true");
        assert_eq!(js_string(&json!("u1")), "u1");
    }

    #[test]
    fn a_missing_enqueue_row_is_an_error() {
        let executor = RecordingExecutor::new(vec![Ok(PgQueryResult::empty())]);
        let error = drive_sync(enqueue_outbox_event::<PgError>(
            &executor,
            None,
            &event_input(),
        ))
        .expect("bridge")
        .expect_err("no row");
        assert_eq!(error.message, MISSING_OUTBOX_ROW);
    }
}
