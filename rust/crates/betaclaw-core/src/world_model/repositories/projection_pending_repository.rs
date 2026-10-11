//! Port of
//! `src/server/world-model/repositories/projectionPendingRepository.ts`
//! (133 lines) — the retry queue of a failed projection.
//!
//! | TypeScript | Rust |
//! | --- | --- |
//! | `projectionPendingRepository.ts:4-17` (`ProjectionPendingRecord`) | [`ProjectionPendingRecord`], [`ProjectionPendingStatus`] |
//! | `projectionPendingRepository.ts:19-34` (`PendingRow`) | the column names of the statements |
//! | `projectionPendingRepository.ts:36-55` (`toPending`) | [`to_pending`] |
//! | `projectionPendingRepository.ts:57-59` (`SELECT`) | [`SELECT_COLUMNS`] |
//! | `projectionPendingRepository.ts:61-93` (`enqueueProjectionPending`) | [`enqueue_projection_pending`], [`ProjectionPendingInput`] |
//! | `projectionPendingRepository.ts:95-105` (`markProjectionPendingSucceeded`) | [`mark_projection_pending_succeeded`] |
//! | `projectionPendingRepository.ts:107-118` (`listDueProjectionPending`) | [`list_due_projection_pending`] |
//! | `projectionPendingRepository.ts:120-133` (`markProjectionPendingFailed`) | [`mark_projection_pending_failed`] |
//! | `projectionPendingRepository.ts:73-80` (upsert) | [`enqueue_sql`] |
//! | `projectionPendingRepository.ts:100-102` (succeeded) | [`SQL_MARK_SUCCEEDED`] |
//! | `projectionPendingRepository.ts:112-114` (due list) | [`due_sql`] |
//! | `projectionPendingRepository.ts:126-131` (failed) | [`SQL_MARK_FAILED`] |
//!
//! # Scope
//!
//! `input.scope` (`:63`) is required in the source and fills the tenant columns
//! (`:82-84`); the ambient RLS scope at the call site is the same object
//! (`projector/projectWindow.ts` runs the enqueue inside
//! `withWorldModelTransaction`), so [`enqueue_projection_pending`] takes it once,
//! as a required parameter, and always runs scoped.
//!
//! The three worker functions are called both ways in the source:
//! `runProjectionRetryOnce` calls them without a scope
//! (`services/projectionRetryWorker.ts:200-214`) and the same function runs
//! inside `runWithWorldModelScope` for every discovered scope (`:226-227`), which
//! is why they take the ambient `Option<&WorldModelScope>`.
//!
//! # Deviations
//!
//! 1. **`slice(0, 2000)` counts UTF-16 code units.** JavaScript's
//!    `String.prototype.slice` cuts between code units, so a surrogate pair that
//!    straddles the boundary is split; a Rust `String` cannot hold a lone
//!    surrogate, so [`truncate_message`] stops before the pair instead of
//!    half-writing it.
//! 2. **A missing `RETURNING` row is an error instead of a `TypeError`.** The
//!    source reads `result.rows[0]!` (`:92`); the port answers
//!    [`MISSING_PENDING_ROW`].

use serde_json::{Map, Value};

use crate::world_model::db::{scoped_query, PgError, PgExecutor, PgRow, PgStatement, PgValue};
use crate::world_model::repositories::{
    ambient_query, normalized_scope, row_integer, row_object, row_optional_text, row_text,
};
use crate::world_model::scope::WorldModelScope;

/// `ProjectionPendingRecord` from `projectionPendingRepository.ts:4-17`.
#[derive(Debug, Clone, PartialEq)]
pub struct ProjectionPendingRecord {
    pub id: String,
    /// `{ userId, personaId, workspaceId }` of `:39-43`.
    pub scope: WorldModelScope,
    pub projection_type: String,
    pub source_observation_id: Option<String>,
    pub source_window_id: String,
    pub payload: Map<String, Value>,
    pub attempts: i64,
    pub status: ProjectionPendingStatus,
    pub error_message: Option<String>,
    pub next_attempt_at: String,
    pub created_at: String,
    pub updated_at: String,
}

/// `ProjectionPendingRecord['status']` from `projectionPendingRepository.ts:12`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProjectionPendingStatus {
    Pending,
    Succeeded,
    Failed,
}

impl ProjectionPendingStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            ProjectionPendingStatus::Pending => "pending",
            ProjectionPendingStatus::Succeeded => "succeeded",
            ProjectionPendingStatus::Failed => "failed",
        }
    }
}

/// The input of `enqueueProjectionPending`
/// (`projectionPendingRepository.ts:62-69`).
#[derive(Debug, Clone, PartialEq)]
pub struct ProjectionPendingInput {
    /// `scope: WorldModelScope`.
    pub scope: WorldModelScope,
    pub projection_type: String,
    pub source_observation_id: Option<String>,
    pub source_window_id: String,
    /// `payload?: Record<string, unknown>` — `JSON.stringify(payload ?? {})`.
    pub payload: Option<Map<String, Value>>,
    /// `errorMessage?: string` — `errorMessage?.slice(0, 2000) ?? null`.
    pub error_message: Option<String>,
}

/// The `SELECT` column list of `projectionPendingRepository.ts:57-59`.
pub const SELECT_COLUMNS: &str = "id, user_id, persona_id, workspace_id, projection_type,\n  source_observation_id, source_window_id, payload, attempts, status,\n  error_message, next_attempt_at, created_at, updated_at";

/// `projectionPendingRepository.ts:73-80` with `RETURNING ${SELECT}` expanded.
pub fn enqueue_sql() -> String {
    format!(
        "INSERT INTO world_model_projection_pending\n  (user_id, persona_id, workspace_id, projection_type, source_observation_id,\n   source_window_id, payload, error_message)\nVALUES ($1,$2,$3,$4,$5,$6,$7,$8)\nON CONFLICT (user_id, persona_id, workspace_id, projection_type, source_window_id)\n  DO UPDATE SET payload = EXCLUDED.payload, error_message = EXCLUDED.error_message,\n                status = 'pending', next_attempt_at = now(), updated_at = now()\nRETURNING {SELECT_COLUMNS}"
    )
}

/// `projectionPendingRepository.ts:100-102`.
pub const SQL_MARK_SUCCEEDED: &str = "UPDATE world_model_projection_pending\nSET status = 'succeeded', error_message = NULL, updated_at = now()\nWHERE id = $1";

/// `projectionPendingRepository.ts:112-114` with `${SELECT}` expanded.
pub fn due_sql() -> String {
    format!(
        "SELECT {SELECT_COLUMNS} FROM world_model_projection_pending\nWHERE status IN ('pending','failed') AND next_attempt_at <= now()\nORDER BY created_at ASC LIMIT $1"
    )
}

/// `projectionPendingRepository.ts:126-131`.
pub const SQL_MARK_FAILED: &str = "UPDATE world_model_projection_pending\nSET status = 'failed', attempts = attempts + 1, error_message = $2,\n    next_attempt_at = now() + (LEAST(300000, 1000 * power(2, attempts + 1)) * interval '1 millisecond'),\n    updated_at = now()\nWHERE id = $1";

/// The port's answer for `result.rows[0]!` (`:92`) — deviation 2.
pub const MISSING_PENDING_ROW: &str = "[world-model] projection pending upsert returned no row";

/// `toPending(row)` — `projectionPendingRepository.ts:36-55`.
fn to_pending(row: &PgRow) -> ProjectionPendingRecord {
    ProjectionPendingRecord {
        id: row_text(row, "id"),
        scope: WorldModelScope::new(
            row_text(row, "user_id"),
            row_text(row, "persona_id"),
            Some(row_text(row, "workspace_id")),
        ),
        projection_type: row_text(row, "projection_type"),
        source_observation_id: row_optional_text(row, "source_observation_id"),
        source_window_id: row_text(row, "source_window_id"),
        payload: row_object(row, "payload"),
        attempts: row_integer(row, "attempts"),
        status: status_from_column(&row_text(row, "status")),
        error_message: row_optional_text(row, "error_message"),
        next_attempt_at: row_text(row, "next_attempt_at"),
        created_at: row_text(row, "created_at"),
        updated_at: row_text(row, "updated_at"),
    }
}

/// The `status` column of a row; an out-of-union literal falls back to
/// [`ProjectionPendingStatus::Pending`], the state the enqueue resets to.
fn status_from_column(text: &str) -> ProjectionPendingStatus {
    match text {
        "succeeded" => ProjectionPendingStatus::Succeeded,
        "failed" => ProjectionPendingStatus::Failed,
        _ => ProjectionPendingStatus::Pending,
    }
}

/// `errorMessage.slice(0, 2000)` — `projectionPendingRepository.ts:89`, `:131`
/// (deviation 1).
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

/// `enqueueProjectionPending(input, db)` — `projectionPendingRepository.ts:61-93`.
///
/// The upsert resets a previously failed record to `pending` and pushes its
/// `next_attempt_at` to `now()`, so a re-enqueued projection is due immediately.
pub async fn enqueue_projection_pending<E: From<PgError> + Send + 'static>(
    executor: &dyn PgExecutor,
    input: &ProjectionPendingInput,
) -> Result<ProjectionPendingRecord, E> {
    let parts = input.scope.parts();
    let result = scoped_query::<E>(
        executor,
        &normalized_scope(&input.scope),
        PgStatement::with_params(
            enqueue_sql(),
            vec![
                PgValue::text(parts.user_id.as_str()),
                PgValue::text(parts.persona_id.as_str()),
                PgValue::text(parts.workspace_id.as_str()),
                PgValue::text(input.projection_type.as_str()),
                PgValue::nullable_text(input.source_observation_id.clone()),
                PgValue::text(input.source_window_id.as_str()),
                PgValue::text(Value::Object(input.payload.clone().unwrap_or_default()).to_string()),
                match input.error_message.as_deref() {
                    Some(message) => PgValue::text(truncate_message(message)),
                    None => PgValue::Null,
                },
            ],
        ),
    )
    .await?;
    match result.first() {
        Some(row) => Ok(to_pending(row)),
        None => Err(E::from(PgError::new(MISSING_PENDING_ROW))),
    }
}

/// `markProjectionPendingSucceeded(id, db)` — `projectionPendingRepository.ts:95-105`.
pub async fn mark_projection_pending_succeeded<E: From<PgError> + Send + 'static>(
    executor: &dyn PgExecutor,
    scope: Option<&WorldModelScope>,
    id: &str,
) -> Result<(), E> {
    ambient_query::<E>(
        executor,
        scope,
        PgStatement::with_params(SQL_MARK_SUCCEEDED, vec![PgValue::text(id)]),
    )
    .await
    .map(|_| ())
}

/// `listDueProjectionPending(limit = 50, db)` —
/// `projectionPendingRepository.ts:107-118`.
pub async fn list_due_projection_pending<E: From<PgError> + Send + 'static>(
    executor: &dyn PgExecutor,
    scope: Option<&WorldModelScope>,
    limit: Option<i64>,
) -> Result<Vec<ProjectionPendingRecord>, E> {
    let result = ambient_query::<E>(
        executor,
        scope,
        PgStatement::with_params(due_sql(), vec![PgValue::Int64(limit.unwrap_or(50))]),
    )
    .await?;
    Ok(result.rows.iter().map(to_pending).collect())
}

/// `markProjectionPendingFailed(id, errorMessage, db)` —
/// `projectionPendingRepository.ts:120-133`.
pub async fn mark_projection_pending_failed<E: From<PgError> + Send + 'static>(
    executor: &dyn PgExecutor,
    scope: Option<&WorldModelScope>,
    id: &str,
    error_message: &str,
) -> Result<(), E> {
    ambient_query::<E>(
        executor,
        scope,
        PgStatement::with_params(
            SQL_MARK_FAILED,
            vec![
                PgValue::text(id),
                PgValue::text(truncate_message(error_message)),
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

    fn input() -> ProjectionPendingInput {
        ProjectionPendingInput {
            scope: WorldModelScope::new("u1", "p1", Some("w1".to_string())),
            projection_type: "entity".to_string(),
            source_observation_id: None,
            source_window_id: "window-1".to_string(),
            payload: None,
            error_message: None,
        }
    }

    fn pending_row() -> PgRow {
        json!({
            "id": "p1",
            "user_id": "u1",
            "persona_id": "p1",
            "workspace_id": "w1",
            "projection_type": "entity",
            "source_observation_id": null,
            "source_window_id": "window-1",
            "payload": { "kind": "person" },
            "attempts": 2,
            "status": "failed",
            "error_message": "boom",
            "next_attempt_at": "2026-10-10T10:00:00.000Z",
            "created_at": "2026-10-10T09:00:00.000Z",
            "updated_at": "2026-10-10T09:30:00.000Z",
        })
        .as_object()
        .expect("object")
        .clone()
    }

    #[test]
    fn an_enqueue_runs_scoped_and_maps_the_record() {
        let executor =
            RecordingExecutor::new(vec![Ok(PgQueryResult::from_rows(vec![pending_row()]))]);
        let record = drive_sync(enqueue_projection_pending::<PgError>(&executor, &input()))
            .expect("bridge")
            .expect("enqueue");
        assert_eq!(record.id, "p1");
        assert_eq!(record.scope, input().scope);
        assert_eq!(record.attempts, 2);
        assert_eq!(record.status, ProjectionPendingStatus::Failed);
        assert_eq!(record.payload["kind"], json!("person"));
        assert_eq!(record.error_message.as_deref(), Some("boom"));

        let calls = executor.calls();
        let sqls: Vec<String> = calls
            .iter()
            .filter(|call| !matches!(call, Recorded::Release))
            .map(|call| call.sql().to_string())
            .collect();
        assert_eq!(
            sqls,
            vec![
                SQL_BEGIN.to_string(),
                SQL_SET_SCOPE.to_string(),
                enqueue_sql(),
                SQL_COMMIT.to_string(),
            ]
        );
        match &calls[2] {
            Recorded::Statement(statement) => assert_eq!(
                statement.params,
                vec![
                    PgValue::text("u1"),
                    PgValue::text("p1"),
                    PgValue::text("w1"),
                    PgValue::text("entity"),
                    PgValue::Null,
                    PgValue::text("window-1"),
                    PgValue::text("{}"),
                    PgValue::Null,
                ],
                "`sourceObservationId ?? null`, `JSON.stringify(payload ?? {{}})`, \
                 `errorMessage?.slice(0, 2000) ?? null`"
            ),
            other => panic!("expected the upsert, got {other:?}"),
        }
    }

    #[test]
    fn the_error_message_is_cut_at_two_thousand_code_units() {
        let executor =
            RecordingExecutor::new(vec![Ok(PgQueryResult::from_rows(vec![pending_row()]))]);
        let mut with_message = input();
        with_message.error_message = Some("x".repeat(2500));
        drive_sync(enqueue_projection_pending::<PgError>(
            &executor,
            &with_message,
        ))
        .expect("bridge")
        .expect("enqueue");
        match &executor.calls()[2] {
            Recorded::Statement(statement) => match &statement.params[7] {
                PgValue::Text(message) => assert_eq!(message.len(), 2000),
                other => panic!("expected the truncated message, got {other:?}"),
            },
            other => panic!("expected the upsert, got {other:?}"),
        }

        // A surrogate pair that would straddle the boundary is dropped whole
        // (deviation 1): 2000 units fit 1999 ASCII plus the emoji (2 units).
        let straddling = format!("{}🙂", "x".repeat(1999));
        assert_eq!(truncate_message(&straddling), "x".repeat(1999));
        assert_eq!(
            truncate_message(&format!("{}🙂", "x".repeat(1998))).len(),
            1998 + 4
        );
    }
    // SENTINEL-END

    #[test]
    fn a_missing_returning_row_is_an_error() {
        let executor = RecordingExecutor::new(vec![Ok(PgQueryResult::empty())]);
        let error = drive_sync(enqueue_projection_pending::<PgError>(&executor, &input()))
            .expect("bridge")
            .expect_err("no row");
        assert_eq!(error.message, MISSING_PENDING_ROW);
    }

    #[test]
    fn the_worker_statements_switch_between_the_scoped_and_the_bare_pool_query() {
        let scoped =
            RecordingExecutor::new(vec![Ok(PgQueryResult::from_rows(vec![pending_row()]))]);
        let records = drive_sync(list_due_projection_pending::<PgError>(
            &scoped,
            Some(&WorldModelScope::new("u1", "p1", None)),
            None,
        ))
        .expect("bridge")
        .expect("list");
        assert_eq!(records.len(), 1);
        assert_eq!(
            records[0].scope.workspace_id.as_deref(),
            Some("w1"),
            "the record's scope comes from the row, not from the ambient scope"
        );
        let sqls: Vec<String> = scoped
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
                due_sql(),
                SQL_COMMIT.to_string(),
            ]
        );
        match &scoped.calls()[2] {
            Recorded::Statement(statement) => {
                assert_eq!(statement.params, vec![PgValue::Int64(50)], "`limit = 50`");
            }
            other => panic!("expected the due list, got {other:?}"),
        }

        let unscoped = RecordingExecutor::new(vec![Ok(PgQueryResult::empty())]);
        drive_sync(mark_projection_pending_succeeded::<PgError>(
            &unscoped, None, "p1",
        ))
        .expect("bridge")
        .expect("mark");
        match &unscoped.calls()[0] {
            Recorded::Statement(statement) => {
                assert_eq!(statement.sql, SQL_MARK_SUCCEEDED);
                assert_eq!(statement.params, vec![PgValue::text("p1")]);
            }
            other => panic!("expected the success mark, got {other:?}"),
        }

        let limited = RecordingExecutor::new(vec![Ok(PgQueryResult::empty())]);
        drive_sync(list_due_projection_pending::<PgError>(
            &limited,
            None,
            Some(5),
        ))
        .expect("bridge")
        .expect("list");
        match &limited.calls()[0] {
            Recorded::Statement(statement) => {
                assert_eq!(statement.params, vec![PgValue::Int64(5)]);
            }
            other => panic!("expected the due list, got {other:?}"),
        }
    }

    #[test]
    fn the_failure_mark_binds_the_truncated_message() {
        let executor = RecordingExecutor::new(vec![Ok(PgQueryResult::empty())]);
        drive_sync(mark_projection_pending_failed::<PgError>(
            &executor,
            Some(&WorldModelScope::new("u1", "p1", None)),
            "p1",
            &"e".repeat(2001),
        ))
        .expect("bridge")
        .expect("mark");
        match &executor.calls()[2] {
            Recorded::Statement(statement) => {
                assert_eq!(statement.sql, SQL_MARK_FAILED);
                assert_eq!(
                    statement.params,
                    vec![PgValue::text("p1"), PgValue::text("e".repeat(2000))]
                );
            }
            other => panic!("expected the failure mark, got {other:?}"),
        }
    }
}
