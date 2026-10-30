//! Port of `src/server/world-model/repositories/prospectiveRepository.ts:1-446`.
//!
//! Queries preserve the source's per-statement transaction behavior. The worker
//! claims a due open loop with the same `FOR UPDATE SKIP LOCKED` lease update.

use serde_json::{json, Value};

use crate::js::js_number_str;
use crate::world_model::db::{PgError, PgExecutor, PgRow, PgStatement, PgValue};
use crate::world_model::repositories::{ambient_query, row_integer, row_optional_text, row_text};
use crate::world_model::scope::WorldModelScope;
use crate::world_model::types::{
    OpenLoopInput, OpenLoopRecord, OpenLoopStatus, OpenLoopType, StandingIntentInput,
    StandingIntentRecord, StandingIntentStatus,
};

const OPEN_LOOP_COLUMNS: &str =
    "id, user_id, persona_id, workspace_id, type, status, subject_id, question,
            missing_information, importance, trigger_at, do_not_ask_before, last_checked_at,
            deduplication_key, max_attempts, attempts, last_asked_at, resolved_observation_id,
            note, created_at, updated_at";
const INTENT_COLUMNS: &str =
    "id, user_id, persona_id, workspace_id, description, trigger_terms, event_type,
            subject_scope, channel_scope, sender_scope, status, expires_at, cooldown_until,
            cooldown_ms, fire_count, max_fires, last_fired_at, deduplication_key, note,
            created_at, updated_at";

fn optional_text(row: &PgRow, column: &str) -> Option<String> {
    row_optional_text(row, column)
}

fn timestamp(row: &PgRow, column: &str) -> Option<String> {
    optional_text(row, column)
}

fn open_loop_type(value: &str) -> OpenLoopType {
    serde_json::from_value(Value::String(value.to_string())).unwrap_or(OpenLoopType::MissingContext)
}

fn open_loop_status(value: &str) -> OpenLoopStatus {
    serde_json::from_value(Value::String(value.to_string())).unwrap_or(OpenLoopStatus::Open)
}

fn intent_status(value: &str) -> StandingIntentStatus {
    serde_json::from_value(Value::String(value.to_string())).unwrap_or(StandingIntentStatus::Armed)
}

fn open_loop_type_text(value: OpenLoopType) -> &'static str {
    match value {
        OpenLoopType::Clarification => "clarification",
        OpenLoopType::Confirmation => "confirmation",
        OpenLoopType::EventOutcome => "event_outcome",
        OpenLoopType::Dependency => "dependency",
        OpenLoopType::MissingContext => "missing_context",
        OpenLoopType::PromisedFollowUp => "promised_follow_up",
    }
}

fn open_loop_status_text(value: OpenLoopStatus) -> &'static str {
    match value {
        OpenLoopStatus::Open => "open",
        OpenLoopStatus::Scheduled => "scheduled",
        OpenLoopStatus::Asked => "asked",
        OpenLoopStatus::Answered => "answered",
        OpenLoopStatus::Resolved => "resolved",
        OpenLoopStatus::Cancelled => "cancelled",
        OpenLoopStatus::Expired => "expired",
    }
}

fn open_loop_from_row(row: &PgRow) -> OpenLoopRecord {
    OpenLoopRecord {
        input: OpenLoopInput {
            user_id: row_text(row, "user_id"),
            persona_id: row_text(row, "persona_id"),
            workspace_id: Some(row_text(row, "workspace_id")),
            loop_type: open_loop_type(&row_text(row, "type")),
            subject_id: optional_text(row, "subject_id"),
            question: optional_text(row, "question"),
            missing_information: optional_text(row, "missing_information"),
            importance: Some(crate::world_model::repositories::row_number(
                row,
                "importance",
            )),
            trigger_at: timestamp(row, "trigger_at"),
            do_not_ask_before: timestamp(row, "do_not_ask_before"),
            deduplication_key: row_text(row, "deduplication_key"),
            max_attempts: Some(row_integer(row, "max_attempts")),
        },
        id: row_text(row, "id"),
        status: open_loop_status(&row_text(row, "status")),
        attempts: row_integer(row, "attempts"),
        last_checked_at: timestamp(row, "last_checked_at"),
        last_asked_at: timestamp(row, "last_asked_at"),
        resolved_observation_id: optional_text(row, "resolved_observation_id"),
        note: optional_text(row, "note"),
        created_at: row_text(row, "created_at"),
        updated_at: row_text(row, "updated_at"),
    }
}

fn intent_from_row(row: &PgRow) -> StandingIntentRecord {
    let trigger_terms = row
        .get("trigger_terms")
        .and_then(Value::as_array)
        .map(|terms| {
            terms
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    StandingIntentRecord {
        input: StandingIntentInput {
            user_id: row_text(row, "user_id"),
            persona_id: row_text(row, "persona_id"),
            workspace_id: Some(row_text(row, "workspace_id")),
            description: row_text(row, "description"),
            trigger_terms,
            event_type: optional_text(row, "event_type"),
            subject_scope: optional_text(row, "subject_scope"),
            channel_scope: optional_text(row, "channel_scope"),
            sender_scope: optional_text(row, "sender_scope"),
            expires_at: timestamp(row, "expires_at"),
            cooldown_ms: Some(row_integer(row, "cooldown_ms")),
            max_fires: Some(row_integer(row, "max_fires")),
            deduplication_key: row_text(row, "deduplication_key"),
        },
        id: row_text(row, "id"),
        status: intent_status(&row_text(row, "status")),
        cooldown_until: timestamp(row, "cooldown_until"),
        fire_count: row_integer(row, "fire_count"),
        last_fired_at: timestamp(row, "last_fired_at"),
        created_at: row_text(row, "created_at"),
        updated_at: row_text(row, "updated_at"),
    }
}

fn first<'a, E: From<PgError>>(
    row: Option<&'a PgRow>,
    error: &'static str,
) -> Result<&'a PgRow, E> {
    row.ok_or_else(|| E::from(PgError::new(error)))
}

pub const MISSING_OPEN_LOOP_ROW: &str = "[world-model] open loop insert returned no row";
pub const MISSING_STANDING_INTENT_ROW: &str =
    "[world-model] standing intent insert returned no row";

/// `insertOpenLoop(input)` — `prospectiveRepository.ts:106-151`.
pub async fn insert_open_loop<E: From<PgError> + Send + 'static>(
    executor: &dyn PgExecutor,
    scope: Option<&WorldModelScope>,
    input: &OpenLoopInput,
) -> Result<OpenLoopRecord, E> {
    let result = ambient_query::<E>(executor, scope, PgStatement::with_params(
        format!("INSERT INTO world_model_open_loops\n      (user_id, persona_id, workspace_id, type, subject_id, question, missing_information,\n       importance, trigger_at, do_not_ask_before, deduplication_key, max_attempts)\n     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)\n     ON CONFLICT (user_id, persona_id, workspace_id, deduplication_key) DO UPDATE SET\n       type = EXCLUDED.type, note = COALESCE(world_model_open_loops.note, EXCLUDED.note), updated_at = now()\n     RETURNING {OPEN_LOOP_COLUMNS}"),
        vec![
            PgValue::text(input.user_id.as_str()),
            PgValue::text(input.persona_id.as_str()),
            PgValue::text(input.workspace_id.as_deref().unwrap_or("")),
            PgValue::text(open_loop_type_text(input.loop_type)),
            PgValue::nullable_text(input.subject_id.clone()),
            PgValue::nullable_text(input.question.clone()),
            PgValue::nullable_text(input.missing_information.clone()),
            PgValue::float(input.importance.unwrap_or(1.0)),
            PgValue::nullable_text(input.trigger_at.clone()),
            PgValue::nullable_text(input.do_not_ask_before.clone()),
            PgValue::text(input.deduplication_key.as_str()),
            PgValue::int(input.max_attempts.unwrap_or(3)),
        ],
    )).await?;
    Ok(open_loop_from_row(first::<E>(
        result.first(),
        MISSING_OPEN_LOOP_ROW,
    )?))
}

/// `getOpenLoopByKey` — `prospectiveRepository.ts:153-174`.
pub async fn get_open_loop_by_key<E: From<PgError> + Send + 'static>(
    executor: &dyn PgExecutor,
    scope: Option<&WorldModelScope>,
    user_id: &str,
    persona_id: &str,
    deduplication_key: &str,
    workspace_id: &str,
) -> Result<Option<OpenLoopRecord>, E> {
    let result = ambient_query::<E>(executor, scope, PgStatement::with_params(
        format!("SELECT {OPEN_LOOP_COLUMNS}\n     FROM world_model_open_loops\n     WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3 AND deduplication_key = $4"),
        vec![PgValue::text(user_id), PgValue::text(persona_id), PgValue::text(workspace_id), PgValue::text(deduplication_key)],
    )).await?;
    Ok(result.first().map(open_loop_from_row))
}

/// `updateOpenLoopStatus` — `prospectiveRepository.ts:176-207`.
#[allow(clippy::too_many_arguments)]
pub async fn update_open_loop_status<E: From<PgError> + Send + 'static>(
    executor: &dyn PgExecutor,
    scope: Option<&WorldModelScope>,
    id: &str,
    status: OpenLoopStatus,
    last_checked_at: Option<&str>,
    last_asked_at: Option<&str>,
    resolved_observation_id: Option<&str>,
    note: Option<&str>,
) -> Result<(), E> {
    let sql = "UPDATE world_model_open_loops\n     SET status = $2, last_checked_at = COALESCE($3, last_checked_at),\n         last_asked_at = COALESCE($4, last_asked_at),\n         resolved_observation_id = COALESCE($5, resolved_observation_id),\n         note = COALESCE($6, note), updated_at = now()\n     WHERE id = $1";
    ambient_query::<E>(
        executor,
        scope,
        PgStatement::with_params(
            sql,
            vec![
                PgValue::text(id),
                PgValue::text(open_loop_status_text(status)),
                PgValue::nullable_text(last_checked_at.map(str::to_string)),
                PgValue::nullable_text(last_asked_at.map(str::to_string)),
                PgValue::nullable_text(resolved_observation_id.map(str::to_string)),
                PgValue::nullable_text(note.map(str::to_string)),
            ],
        ),
    )
    .await?;
    Ok(())
}

/// `listDueOpenLoops` — `prospectiveRepository.ts:209-240`.
pub async fn list_due_open_loops<E: From<PgError> + Send + 'static>(
    executor: &dyn PgExecutor,
    scope: Option<&WorldModelScope>,
    user_id: &str,
    persona_id: &str,
    at: &str,
    workspace_id: &str,
    limit: i64,
) -> Result<Vec<OpenLoopRecord>, E> {
    let sql = format!("SELECT {OPEN_LOOP_COLUMNS}\n     FROM world_model_open_loops\n     WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3\n       AND status IN ('open','scheduled')\n       AND (trigger_at IS NULL OR trigger_at <= $4)\n       AND (do_not_ask_before IS NULL OR do_not_ask_before <= $4)\n       AND (next_attempt_at IS NULL OR next_attempt_at <= $4)\n       AND (locked_until IS NULL OR locked_until <= $4)\n     ORDER BY COALESCE(trigger_at, created_at) ASC LIMIT $5");
    let result = ambient_query::<E>(
        executor,
        scope,
        PgStatement::with_params(
            sql,
            vec![
                PgValue::text(user_id),
                PgValue::text(persona_id),
                PgValue::text(workspace_id),
                PgValue::text(at),
                PgValue::int(limit),
            ],
        ),
    )
    .await?;
    Ok(result.rows.iter().map(open_loop_from_row).collect())
}

/// `claimDueOpenLoop` — `prospectiveRepository.ts:242-294`.
#[allow(clippy::too_many_arguments)]
pub async fn claim_due_open_loop<E: From<PgError> + Send + 'static>(
    executor: &dyn PgExecutor,
    scope: Option<&WorldModelScope>,
    user_id: &str,
    persona_id: &str,
    at: &str,
    workspace_id: &str,
    lease_by: &str,
    lease_duration_ms: i64,
) -> Result<Option<OpenLoopRecord>, E> {
    let lease_until = chrono::DateTime::parse_from_rfc3339(at)
        .map(|instant| {
            (instant + chrono::Duration::milliseconds(lease_duration_ms))
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        })
        .map_err(|_| E::from(PgError::new("Invalid time value")))?;
    let sql = format!("UPDATE world_model_open_loops\n     SET locked_by = $5,\n         locked_until = $6,\n         updated_at = now()\n     WHERE id = (\n       SELECT id FROM world_model_open_loops\n       WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3\n         AND status IN ('open','scheduled')\n         AND (trigger_at IS NULL OR trigger_at <= $4)\n         AND (do_not_ask_before IS NULL OR do_not_ask_before <= $4)\n         AND (next_attempt_at IS NULL OR next_attempt_at <= $4)\n         AND (locked_until IS NULL OR locked_until <= $4)\n       ORDER BY COALESCE(trigger_at, created_at) ASC\n       FOR UPDATE SKIP LOCKED\n       LIMIT 1\n     )\n     RETURNING {OPEN_LOOP_COLUMNS}");
    let result = ambient_query::<E>(
        executor,
        scope,
        PgStatement::with_params(
            sql,
            vec![
                PgValue::text(user_id),
                PgValue::text(persona_id),
                PgValue::text(workspace_id),
                PgValue::text(at),
                PgValue::text(lease_by),
                PgValue::text(lease_until),
            ],
        ),
    )
    .await?;
    Ok(result.first().map(open_loop_from_row))
}

/// `releaseOpenLoopLease` — `prospectiveRepository.ts:296-312`.
pub async fn release_open_loop_lease<E: From<PgError> + Send + 'static>(
    executor: &dyn PgExecutor,
    scope: Option<&WorldModelScope>,
    loop_id: &str,
    next_attempt_at: Option<&str>,
) -> Result<(), E> {
    let sql = "UPDATE world_model_open_loops\n     SET locked_by = NULL,\n         locked_until = NULL,\n         next_attempt_at = COALESCE($2, next_attempt_at),\n         updated_at = now()\n     WHERE id = $1";
    ambient_query::<E>(
        executor,
        scope,
        PgStatement::with_params(
            sql,
            vec![
                PgValue::text(loop_id),
                PgValue::nullable_text(next_attempt_at.map(str::to_string)),
            ],
        ),
    )
    .await?;
    Ok(())
}

/// `listAskedOpenLoops` — `prospectiveRepository.ts:314-339`.
pub async fn list_asked_open_loops<E: From<PgError> + Send + 'static>(
    executor: &dyn PgExecutor,
    scope: Option<&WorldModelScope>,
    user_id: &str,
    persona_id: &str,
    workspace_id: &str,
    limit: i64,
) -> Result<Vec<OpenLoopRecord>, E> {
    let sql = format!("SELECT {OPEN_LOOP_COLUMNS}\n     FROM world_model_open_loops\n     WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3\n       AND status = 'asked' AND last_asked_at IS NOT NULL\n     ORDER BY last_asked_at DESC\n     LIMIT $4");
    let result = ambient_query::<E>(
        executor,
        scope,
        PgStatement::with_params(
            sql,
            vec![
                PgValue::text(user_id),
                PgValue::text(persona_id),
                PgValue::text(workspace_id),
                PgValue::int(limit),
            ],
        ),
    )
    .await?;
    Ok(result.rows.iter().map(open_loop_from_row).collect())
}

/// `listActiveProspectiveScopes` — `prospectiveRepository.ts:341-353`.
pub async fn list_active_prospective_scopes<E: From<PgError> + Send + 'static>(
    executor: &dyn PgExecutor,
) -> Result<Vec<(String, String, String)>, E> {
    let result = executor.query(PgStatement::new("SELECT DISTINCT user_id, persona_id, workspace_id\n     FROM world_model_open_loops\n     WHERE status IN ('open','scheduled')")).await.map_err(E::from)?;
    Ok(result
        .rows
        .iter()
        .map(|row| {
            (
                row_text(row, "user_id"),
                row_text(row, "persona_id"),
                row_text(row, "workspace_id"),
            )
        })
        .collect())
}

/// `listOverdueOpenLoops` — `prospectiveRepository.ts:355-380`.
pub async fn list_overdue_open_loops<E: From<PgError> + Send + 'static>(
    executor: &dyn PgExecutor,
    scope: Option<&WorldModelScope>,
    max_age_ms: i64,
    now: &str,
    limit: i64,
) -> Result<Vec<OpenLoopRecord>, E> {
    let cutoff = chrono::DateTime::parse_from_rfc3339(now)
        .map(|instant| {
            (instant - chrono::Duration::milliseconds(max_age_ms))
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        })
        .map_err(|_| E::from(PgError::new("Invalid time value")))?;
    let sql = format!("SELECT {OPEN_LOOP_COLUMNS} FROM world_model_open_loops WHERE status = 'open' AND updated_at <= $1\n     ORDER BY updated_at ASC LIMIT $2");
    let result = ambient_query::<E>(
        executor,
        scope,
        PgStatement::with_params(sql, vec![PgValue::text(cutoff), PgValue::int(limit)]),
    )
    .await?;
    Ok(result.rows.iter().map(open_loop_from_row).collect())
}

/// `insertStandingIntent` — `prospectiveRepository.ts:382-419`.
pub async fn insert_standing_intent<E: From<PgError> + Send + 'static>(
    executor: &dyn PgExecutor,
    scope: Option<&WorldModelScope>,
    input: &StandingIntentInput,
) -> Result<StandingIntentRecord, E> {
    let sql = format!("INSERT INTO world_model_standing_intents\n      (user_id, persona_id, workspace_id, description, trigger_terms, event_type, subject_scope,\n       channel_scope, sender_scope, expires_at, cooldown_ms, max_fires, deduplication_key)\n     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)\n     ON CONFLICT (user_id, persona_id, workspace_id, deduplication_key) DO UPDATE SET\n       description = EXCLUDED.description, trigger_terms = EXCLUDED.trigger_terms,\n       event_type = EXCLUDED.event_type, updated_at = now()\n     RETURNING {INTENT_COLUMNS}");
    let result = ambient_query::<E>(
        executor,
        scope,
        PgStatement::with_params(
            sql,
            vec![
                PgValue::text(input.user_id.as_str()),
                PgValue::text(input.persona_id.as_str()),
                PgValue::text(input.workspace_id.as_deref().unwrap_or("")),
                PgValue::text(input.description.as_str()),
                PgValue::text(json!(input.trigger_terms).to_string()),
                PgValue::nullable_text(input.event_type.clone()),
                PgValue::nullable_text(input.subject_scope.clone()),
                PgValue::nullable_text(input.channel_scope.clone()),
                PgValue::nullable_text(input.sender_scope.clone()),
                PgValue::nullable_text(input.expires_at.clone()),
                PgValue::int(input.cooldown_ms.unwrap_or(0)),
                PgValue::int(input.max_fires.unwrap_or(0)),
                PgValue::text(input.deduplication_key.as_str()),
            ],
        ),
    )
    .await?;
    Ok(intent_from_row(first::<E>(
        result.first(),
        MISSING_STANDING_INTENT_ROW,
    )?))
}

/// `listArmedStandingIntents` — `prospectiveRepository.ts:421-474`.
pub async fn list_armed_standing_intents<E: From<PgError> + Send + 'static>(
    executor: &dyn PgExecutor,
    scope: Option<&WorldModelScope>,
    user_id: &str,
    persona_id: &str,
    now: &str,
    workspace_id: &str,
) -> Result<Vec<StandingIntentRecord>, E> {
    let statements = [
        "UPDATE world_model_standing_intents\n     SET status = 'expired', updated_at = now()\n     WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $4\n       AND expires_at IS NOT NULL AND expires_at <= $3\n       AND status IN ('armed','cooldown')",
        "UPDATE world_model_standing_intents\n     SET status = 'armed', cooldown_until = NULL, updated_at = now()\n     WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $4 AND status = 'cooldown'\n       AND cooldown_until IS NOT NULL AND cooldown_until <= $3\n       AND (expires_at IS NULL OR expires_at > $3)\n       AND (max_fires = 0 OR fire_count < max_fires)",
    ];
    for sql in statements {
        ambient_query::<E>(
            executor,
            scope,
            PgStatement::with_params(
                sql,
                vec![
                    PgValue::text(user_id),
                    PgValue::text(persona_id),
                    PgValue::text(now),
                    PgValue::text(workspace_id),
                ],
            ),
        )
        .await?;
    }
    let result = ambient_query::<E>(executor, scope, PgStatement::with_params(
        format!("SELECT {INTENT_COLUMNS}\n     FROM world_model_standing_intents\n     WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $4 AND status = 'armed'\n       AND (expires_at IS NULL OR expires_at > $3)\n       AND (max_fires = 0 OR fire_count < max_fires)"),
        vec![PgValue::text(user_id), PgValue::text(persona_id), PgValue::text(now), PgValue::text(workspace_id)],
    )).await?;
    Ok(result.rows.iter().map(intent_from_row).collect())
}

/// `registerStandingIntentFire` — `prospectiveRepository.ts:476-495`.
pub async fn register_standing_intent_fire<E: From<PgError> + Send + 'static>(
    executor: &dyn PgExecutor,
    scope: Option<&WorldModelScope>,
    id: &str,
    now: &str,
) -> Result<(), E> {
    let sql = "UPDATE world_model_standing_intents\n     SET fire_count = fire_count + 1, last_fired_at = $2,\n         cooldown_until = CASE WHEN cooldown_ms > 0\n           THEN ($2::timestamptz + make_interval(secs => cooldown_ms / 1000.0)) ELSE cooldown_until END,\n         status = CASE\n           WHEN max_fires > 0 AND fire_count + 1 >= max_fires THEN 'done'::world_model_standing_intent_status\n           WHEN cooldown_ms > 0 THEN 'cooldown'::world_model_standing_intent_status\n           ELSE 'armed'::world_model_standing_intent_status END,\n         updated_at = now()\n     WHERE id = $1";
    ambient_query::<E>(
        executor,
        scope,
        PgStatement::with_params(sql, vec![PgValue::text(id), PgValue::text(now)]),
    )
    .await?;
    Ok(())
}

/// `markOpenLoopAsked` — `prospectiveRepository.ts:497-514`.
pub async fn mark_open_loop_asked<E: From<PgError> + Send + 'static>(
    executor: &dyn PgExecutor,
    scope: Option<&WorldModelScope>,
    loop_id: &str,
    now: &str,
) -> Result<(), E> {
    let sql = "UPDATE world_model_open_loops\n     SET attempts = attempts + 1,\n         last_asked_at = $2,\n         status = CASE\n           WHEN attempts + 1 >= max_attempts THEN 'expired'::world_model_open_loop_status\n           ELSE 'asked'::world_model_open_loop_status\n         END,\n         updated_at = now()\n     WHERE id = $1 AND status IN ('open','scheduled')\n       AND (do_not_ask_before IS NULL OR do_not_ask_before <= $2)";
    ambient_query::<E>(
        executor,
        scope,
        PgStatement::with_params(sql, vec![PgValue::text(loop_id), PgValue::text(now)]),
    )
    .await?;
    Ok(())
}

/// `countAskedOpenLoopsToday` — `prospectiveRepository.ts:516-540`.
pub async fn count_asked_open_loops_today<E: From<PgError> + Send + 'static>(
    executor: &dyn PgExecutor,
    scope: Option<&WorldModelScope>,
    user_id: &str,
    persona_id: &str,
    workspace_id: &str,
    start_of_day: &str,
) -> Result<f64, E> {
    let result = ambient_query::<E>(executor, scope, PgStatement::with_params(
        "SELECT COUNT(*)::text AS count\n     FROM world_model_open_loops\n     WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3\n       AND last_asked_at >= $4",
        vec![PgValue::text(user_id), PgValue::text(persona_id), PgValue::text(workspace_id), PgValue::text(start_of_day)],
    )).await?;
    Ok(result
        .first()
        .map(|row| js_number_str(&row_text(row, "count")))
        .unwrap_or(0.0))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world_model::db::drive_sync;
    use crate::world_model::db::testing::{Recorded, RecordingExecutor};
    use crate::world_model::db::{PgQueryResult, SQL_BEGIN, SQL_COMMIT, SQL_SET_SCOPE};
    use serde_json::json;

    fn row(value: Value) -> PgRow {
        value.as_object().expect("row").clone()
    }

    fn loop_row() -> PgRow {
        row(json!({
            "id":"l1", "user_id":"u1", "persona_id":"p1", "workspace_id":"",
            "type":"clarification", "status":"open", "subject_id":null, "question":"Which?",
            "missing_information":null, "importance":1, "trigger_at":null, "do_not_ask_before":null,
            "last_checked_at":null, "deduplication_key":"key", "max_attempts":3, "attempts":0,
            "last_asked_at":null, "resolved_observation_id":null, "note":null,
            "created_at":"2026-10-10T10:00:00.000Z", "updated_at":"2026-10-10T10:00:00.000Z"
        }))
    }

    fn input() -> OpenLoopInput {
        OpenLoopInput {
            user_id: "u1".into(),
            persona_id: "p1".into(),
            workspace_id: None,
            loop_type: OpenLoopType::Clarification,
            subject_id: None,
            question: Some("Which?".into()),
            missing_information: None,
            importance: None,
            trigger_at: None,
            do_not_ask_before: None,
            deduplication_key: "key".into(),
            max_attempts: None,
        }
    }

    #[test]
    fn insertion_binds_null_defaults_and_maps_the_record() {
        let executor = RecordingExecutor::new(vec![Ok(PgQueryResult::from_rows(vec![loop_row()]))]);
        let record = drive_sync(insert_open_loop::<PgError>(&executor, None, &input()))
            .expect("bridge")
            .expect("record");
        assert_eq!(record.id, "l1");
        assert_eq!(record.input.question.as_deref(), Some("Which?"));
        match &executor.calls()[0] {
            Recorded::Statement(statement) => assert_eq!(
                statement.params,
                vec![
                    PgValue::text("u1"),
                    PgValue::text("p1"),
                    PgValue::text(""),
                    PgValue::text("clarification"),
                    PgValue::Null,
                    PgValue::text("Which?"),
                    PgValue::Null,
                    PgValue::float(1.0),
                    PgValue::Null,
                    PgValue::Null,
                    PgValue::text("key"),
                    PgValue::int(3),
                ]
            ),
            other => panic!("expected insert, got {other:?}"),
        }
    }

    #[test]
    fn claim_uses_a_skip_locked_update_with_the_computed_lease() {
        let executor = RecordingExecutor::new(vec![Ok(PgQueryResult::from_rows(vec![loop_row()]))]);
        let found = drive_sync(claim_due_open_loop::<PgError>(
            &executor,
            None,
            "u1",
            "p1",
            "2026-10-10T10:00:00.000Z",
            "",
            "worker",
            60_000,
        ))
        .expect("bridge")
        .expect("claim");
        assert_eq!(found.map(|loop_record| loop_record.id), Some("l1".into()));
        match &executor.calls()[0] {
            Recorded::Statement(statement) => {
                assert!(statement.sql.contains("FOR UPDATE SKIP LOCKED"));
                assert_eq!(
                    statement.params[5],
                    PgValue::text("2026-10-10T10:01:00.000Z")
                );
            }
            other => panic!("expected claim, got {other:?}"),
        }
    }

    #[test]
    fn scoped_lookup_sets_and_releases_scope() {
        let executor = RecordingExecutor::new(vec![Ok(PgQueryResult::from_rows(vec![loop_row()]))]);
        let scope = WorldModelScope::new("u1", "p1", None);
        let found = drive_sync(get_open_loop_by_key::<PgError>(
            &executor,
            Some(&scope),
            "u1",
            "p1",
            "key",
            "",
        ))
        .expect("bridge")
        .expect("lookup");
        assert_eq!(found.map(|record| record.id), Some("l1".into()));
        let calls = executor.calls();
        assert_eq!(calls[0].sql(), SQL_BEGIN);
        assert_eq!(calls[1].sql(), SQL_SET_SCOPE);
        assert_eq!(calls.last(), Some(&Recorded::Release));
        assert_eq!(calls[calls.len() - 2].sql(), SQL_COMMIT);
    }
}
