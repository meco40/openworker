//! Port of `src/server/agent-v2/repository/utils.ts`.
//!
//! The helpers take the connection of the current transaction. The transaction
//! itself is opened by [`super::repository::AgentV2Repository`].

use chrono::{DateTime, Duration, Utc};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde_json::Value;
use uuid::Uuid;

use super::errors::{AgentV2Error, ErrorCode};
use super::types::{
    AgentCommand, AgentSessionSnapshot, CommandRow, CommandStatus, CommandType, EventEnvelope,
    EventRow, EventType, JsonObject, NewEvent, SessionRow, SessionStatus, AGENT_V2_SCHEMA_VERSION,
};
use crate::stats::util::iso_millis;

pub const REPLAY_RETENTION_HOURS: i64 = 24;

/// `Replay window expired; use session.get snapshot and re-subscribe.`
pub const REPLAY_EXPIRED_MESSAGE: &str =
    "Replay window expired; use session.get snapshot and re-subscribe.";

/// `normalizeIdempotencyKey`: trimmed, and `None` when empty.
pub fn normalize_idempotency_key(value: Option<&str>) -> Option<String> {
    let trimmed = value.unwrap_or("").trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

/// `safeJsonParse` for a stored object. Broken text reads as `None`. A stored
/// array or scalar also reads as `None`, which the TypeScript would return as is.
pub fn parse_object(text: &str) -> Option<JsonObject> {
    match serde_json::from_str::<Value>(text).ok()? {
        Value::Object(object) => Some(object),
        _ => None,
    }
}

/// `replayCutoffIso(now)`: `now` minus the retention window, ISO with millis.
pub fn replay_cutoff(now: DateTime<Utc>) -> String {
    iso_millis(now - Duration::hours(REPLAY_RETENTION_HOURS))
}

/// `resolveSessionStatusAfterCommand`. The TypeScript also takes
/// `hasQueuedCommands`, but both of its branches for that flag return `idle`,
/// so the flag is not passed here.
pub fn resolve_session_status_after_command(status: CommandStatus) -> SessionStatus {
    match status {
        CommandStatus::Aborted => SessionStatus::Aborted,
        CommandStatus::FailedRecoverable => SessionStatus::ErrorRecoverable,
        CommandStatus::Failed => SessionStatus::Error,
        _ => SessionStatus::Idle,
    }
}

/// `Record<string, unknown>` from a `json!` literal.
pub fn object(value: Value) -> JsonObject {
    match value {
        Value::Object(object) => object,
        _ => JsonObject::new(),
    }
}

/// Reads a text column and parses it with one of the closed string sets.
pub fn text_column<T>(
    row: &Row<'_>,
    name: &str,
    parse: fn(&str) -> Option<T>,
) -> rusqlite::Result<T> {
    let text: String = row.get(name)?;
    parse(&text).ok_or_else(|| {
        rusqlite::Error::FromSqlConversionFailure(
            0,
            rusqlite::types::Type::Text,
            format!("unknown value `{text}` in column {name}").into(),
        )
    })
}

pub fn session_row(row: &Row<'_>) -> rusqlite::Result<SessionRow> {
    Ok(SessionRow {
        id: row.get("id")?,
        user_id: row.get("user_id")?,
        conversation_id: row.get("conversation_id")?,
        status: text_column(row, "status", SessionStatus::parse)?,
        revision: row.get("revision")?,
        last_seq: row.get("last_seq")?,
        last_error: row.get("last_error")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        completed_at: row.get("completed_at")?,
    })
}

pub fn command_row(row: &Row<'_>) -> rusqlite::Result<CommandRow> {
    Ok(CommandRow {
        id: row.get("id")?,
        session_id: row.get("session_id")?,
        command_type: text_column(row, "command_type", CommandType::parse)?,
        priority: row.get("priority")?,
        status: text_column(row, "status", CommandStatus::parse)?,
        payload_json: row.get("payload_json")?,
        idempotency_key: row.get("idempotency_key")?,
        enqueued_at: row.get("enqueued_at")?,
        started_at: row.get("started_at")?,
        finished_at: row.get("finished_at")?,
        error_code: row.get("error_code")?,
        error_message: row.get("error_message")?,
        result_json: row.get("result_json")?,
    })
}

pub fn event_row(row: &Row<'_>) -> rusqlite::Result<EventRow> {
    Ok(EventRow {
        id: row.get("id")?,
        session_id: row.get("session_id")?,
        command_id: row.get("command_id")?,
        seq: row.get("seq")?,
        event_type: text_column(row, "type", EventType::parse)?,
        payload_json: row.get("payload_json")?,
        emitted_at: row.get("emitted_at")?,
    })
}

/// `toAgentCommand`.
pub fn to_agent_command(row: CommandRow) -> AgentCommand {
    AgentCommand {
        id: row.id,
        session_id: row.session_id,
        command_type: row.command_type,
        priority: row.priority,
        status: row.status,
        payload: parse_object(&row.payload_json).unwrap_or_default(),
        idempotency_key: row.idempotency_key,
        enqueued_at: row.enqueued_at,
        started_at: row.started_at,
        finished_at: row.finished_at,
        error_code: row.error_code,
        error_message: row.error_message,
        result: row.result_json.as_deref().and_then(parse_object),
    }
}

/// `toEventEnvelope`.
pub fn to_event_envelope(row: EventRow) -> EventEnvelope {
    EventEnvelope {
        schema_version: AGENT_V2_SCHEMA_VERSION.to_string(),
        event_id: row.id,
        session_id: row.session_id,
        command_id: row.command_id,
        seq: row.seq,
        emitted_at: row.emitted_at,
        event_type: row.event_type,
        payload: parse_object(&row.payload_json).unwrap_or_default(),
    }
}

/// `getSessionRow`: `None` when the session does not belong to the user.
pub fn get_session_row(
    connection: &Connection,
    session_id: &str,
    user_id: &str,
) -> Result<Option<SessionRow>, AgentV2Error> {
    Ok(connection
        .query_row(
            "SELECT * FROM agent_v2_sessions WHERE id = ? AND user_id = ? LIMIT 1",
            params![session_id, user_id],
            session_row,
        )
        .optional()?)
}

pub fn get_session_row_or_throw(
    connection: &Connection,
    session_id: &str,
    user_id: &str,
) -> Result<SessionRow, AgentV2Error> {
    get_session_row(connection, session_id, user_id)?
        .ok_or_else(|| AgentV2Error::new(ErrorCode::NotFound, "Session not found."))
}

pub fn get_command_row_or_throw(
    connection: &Connection,
    command_id: &str,
    session_id: &str,
) -> Result<CommandRow, AgentV2Error> {
    let row = connection
        .query_row(
            "SELECT * FROM agent_v2_commands WHERE id = ? AND session_id = ? LIMIT 1",
            params![command_id, session_id],
            command_row,
        )
        .optional()?;
    row.ok_or_else(|| AgentV2Error::new(ErrorCode::NotFound, "Command not found."))
}

pub fn get_command_or_throw(
    connection: &Connection,
    command_id: &str,
) -> Result<AgentCommand, AgentV2Error> {
    let row = connection
        .query_row(
            "SELECT * FROM agent_v2_commands WHERE id = ? LIMIT 1",
            [command_id],
            command_row,
        )
        .optional()?;
    row.map(to_agent_command)
        .ok_or_else(|| AgentV2Error::new(ErrorCode::NotFound, "Command not found."))
}

pub fn count_queued_commands_unsafe(
    connection: &Connection,
    session_id: &str,
) -> Result<i64, AgentV2Error> {
    Ok(connection.query_row(
        "SELECT COUNT(*) AS cnt FROM agent_v2_commands WHERE session_id = ? AND status = 'queued'",
        [session_id],
        |row| row.get(0),
    )?)
}

/// `buildSessionSnapshot` for a row that is already loaded.
pub fn snapshot_of(
    connection: &Connection,
    row: &SessionRow,
) -> Result<AgentSessionSnapshot, AgentV2Error> {
    let queue_depth = count_queued_commands_unsafe(connection, &row.id)?;
    let running_command_id: Option<String> = connection
        .query_row(
            "SELECT id FROM agent_v2_commands WHERE session_id = ? AND status = 'running'
             ORDER BY started_at DESC LIMIT 1",
            [&row.id],
            |found| found.get(0),
        )
        .optional()?;
    Ok(AgentSessionSnapshot {
        id: row.id.clone(),
        user_id: row.user_id.clone(),
        conversation_id: row.conversation_id.clone(),
        status: row.status,
        revision: row.revision,
        last_seq: row.last_seq,
        queue_depth,
        running_command_id,
        last_error: row.last_error.clone(),
        created_at: row.created_at.clone(),
        updated_at: row.updated_at.clone(),
        completed_at: row.completed_at.clone(),
    })
}

/// `buildSessionSnapshot`: loads the row first, and fails when it is not the
/// user's.
pub fn build_session_snapshot(
    connection: &Connection,
    session_id: &str,
    user_id: &str,
) -> Result<AgentSessionSnapshot, AgentV2Error> {
    let row = get_session_row_or_throw(connection, session_id, user_id)?;
    snapshot_of(connection, &row)
}

/// `insertEventsWithIncrementingSeq`. Every event takes the next sequence number
/// after `session.last_seq`, and the session row is updated afterwards, even when
/// `events` is empty, as in the TypeScript.
pub fn insert_events_with_incrementing_seq(
    connection: &Connection,
    session: &SessionRow,
    command_id: Option<&str>,
    events: Vec<NewEvent>,
    emitted_at: &str,
) -> Result<Vec<EventEnvelope>, AgentV2Error> {
    let mut next_seq = session.last_seq;
    let mut envelopes = Vec::with_capacity(events.len());
    for item in events {
        next_seq += 1;
        let event_id = format!("agent-event-{}", Uuid::new_v4());
        let payload_json = serde_json::to_string(&item.payload)?;
        connection.execute(
            "INSERT INTO agent_v2_events (
               id, session_id, command_id, seq, type, payload_json, emitted_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?)",
            params![
                event_id,
                session.id,
                command_id,
                next_seq,
                item.event_type.as_str(),
                payload_json,
                emitted_at,
            ],
        )?;
        envelopes.push(EventEnvelope {
            schema_version: AGENT_V2_SCHEMA_VERSION.to_string(),
            event_id,
            session_id: session.id.clone(),
            command_id: command_id.map(str::to_string),
            seq: next_seq,
            emitted_at: emitted_at.to_string(),
            event_type: item.event_type,
            payload: item.payload,
        });
    }

    connection.execute(
        "UPDATE agent_v2_sessions SET last_seq = ?, updated_at = ? WHERE id = ?",
        params![next_seq, emitted_at, session.id],
    )?;

    Ok(envelopes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn idempotency_key_is_trimmed_and_empty_means_none() {
        assert_eq!(
            normalize_idempotency_key(Some("  k-1 ")),
            Some("k-1".to_string())
        );
        assert_eq!(normalize_idempotency_key(Some("   ")), None);
        assert_eq!(normalize_idempotency_key(None), None);
    }

    #[test]
    fn terminal_command_statuses_map_to_session_statuses() {
        assert_eq!(
            resolve_session_status_after_command(CommandStatus::Aborted),
            SessionStatus::Aborted
        );
        assert_eq!(
            resolve_session_status_after_command(CommandStatus::Failed),
            SessionStatus::Error
        );
        assert_eq!(
            resolve_session_status_after_command(CommandStatus::FailedRecoverable),
            SessionStatus::ErrorRecoverable
        );
        assert_eq!(
            resolve_session_status_after_command(CommandStatus::Completed),
            SessionStatus::Idle
        );
    }

    #[test]
    fn replay_cutoff_is_millisecond_iso_twenty_four_hours_back() {
        let now = DateTime::parse_from_rfc3339("2026-10-11T12:00:00.250Z")
            .expect("fixture")
            .with_timezone(&Utc);
        assert_eq!(replay_cutoff(now), "2026-10-10T12:00:00.250Z");
    }

    #[test]
    fn closed_text_sets_parse_only_their_own_values() {
        assert_eq!(EventType::parse("agent.v2.error"), Some(EventType::Error));
        assert_eq!(EventType::parse("agent.v2.nope"), None);
        assert_eq!(
            serde_json::to_string(&CommandType::FollowUp).expect("serialize"),
            "\"follow_up\""
        );
    }
}
