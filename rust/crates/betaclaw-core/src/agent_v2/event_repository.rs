//! Port of `src/server/agent-v2/repository/eventRepository.ts`.
//!
//! The functions run inside the transaction that the caller opened, except the
//! reads, which do not need one. `now` is passed in where the TypeScript reads the
//! clock, so the retention window can be tested.

use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension};

use super::errors::{AgentV2Error, ErrorCode};
use super::types::{AppendEventInput, EventEnvelope, NewEvent, ReplayEventsInput};
use super::utils::{
    event_row, get_session_row_or_throw, insert_events_with_incrementing_seq, replay_cutoff,
    to_event_envelope, REPLAY_EXPIRED_MESSAGE,
};
use crate::stats::util::now_iso;

pub fn append_event(
    connection: &Connection,
    input: &AppendEventInput,
) -> Result<EventEnvelope, AgentV2Error> {
    let session = get_session_row_or_throw(connection, &input.session_id, &input.user_id)?;
    let now = now_iso();
    let mut events = insert_events_with_incrementing_seq(
        connection,
        &session,
        input.command_id.as_deref(),
        vec![NewEvent {
            event_type: input.event_type,
            payload: input.payload.clone(),
        }],
        &now,
    )?;
    events
        .pop()
        .ok_or_else(|| AgentV2Error::new(ErrorCode::Unavailable, "no event was written"))
}

/// `replayEvents`. A cursor that is older than the oldest retained event fails
/// with `REPLAY_WINDOW_EXPIRED`, and so does a cursor into a session whose events
/// have all been pruned.
pub fn replay_events(
    connection: &Connection,
    input: &ReplayEventsInput,
    now: DateTime<Utc>,
) -> Result<Vec<EventEnvelope>, AgentV2Error> {
    let session = get_session_row_or_throw(connection, &input.session_id, &input.user_id)?;
    let from_seq = input.from_seq.max(0);
    let limit = input
        .limit
        .filter(|value| *value != 0)
        .unwrap_or(500)
        .clamp(1, 5000);
    let cutoff = replay_cutoff(now);

    let min_seq: Option<i64> = connection.query_row(
        "SELECT MIN(seq) AS min_seq FROM agent_v2_events
         WHERE session_id = ? AND emitted_at >= ?",
        params![input.session_id, cutoff],
        |row| row.get(0),
    )?;
    let min_seq = min_seq.unwrap_or(0);

    let expired =
        session.last_seq > from_seq && ((min_seq > 0 && from_seq < min_seq - 1) || min_seq == 0);
    if expired {
        return Err(AgentV2Error::new(
            ErrorCode::ReplayWindowExpired,
            REPLAY_EXPIRED_MESSAGE,
        ));
    }

    let rows = {
        let mut statement = connection.prepare(
            "SELECT * FROM agent_v2_events
             WHERE session_id = ? AND seq > ? AND emitted_at >= ?
             ORDER BY seq ASC
             LIMIT ?",
        )?;
        let mapped = statement.query_map(
            params![input.session_id, from_seq, cutoff, limit],
            event_row,
        )?;
        mapped.collect::<rusqlite::Result<Vec<_>>>()?
    };
    Ok(rows.into_iter().map(to_event_envelope).collect())
}

/// `getCommandResult`: the terminal event of a command, found by command and
/// session, so it works even when the replay cursor is stale.
pub fn get_command_result(
    connection: &Connection,
    command_id: &str,
    session_id: &str,
) -> Result<Option<EventEnvelope>, AgentV2Error> {
    let row = connection
        .query_row(
            "SELECT * FROM agent_v2_events
             WHERE command_id = ? AND session_id = ?
               AND type IN ('agent.v2.command.completed', 'agent.v2.error')
             ORDER BY seq DESC LIMIT 1",
            params![command_id, session_id],
            event_row,
        )
        .optional()?;
    Ok(row.map(to_event_envelope))
}

/// `pruneExpiredEvents`: deletes the events older than the retention window and
/// returns how many rows went.
pub fn prune_expired_events(
    connection: &Connection,
    now: DateTime<Utc>,
) -> Result<usize, AgentV2Error> {
    Ok(connection.execute(
        "DELETE FROM agent_v2_events WHERE emitted_at < ?",
        [replay_cutoff(now)],
    )?)
}
