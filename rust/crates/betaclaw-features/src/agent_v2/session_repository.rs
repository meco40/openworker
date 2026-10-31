//! Port of `src/server/agent-v2/repository/sessionRepository.ts`.
//!
//! The functions run inside the transaction that the caller opened. The
//! `db.transaction` wrapper of the TypeScript sits in
//! [`super::repository::AgentV2Repository`].

use rusqlite::{params, Connection};
use serde_json::json;
use uuid::Uuid;

use super::errors::AgentV2Error;
use super::types::{
    AgentSessionSnapshot, CreateSessionInput, CreateSessionResult, EventType, NewEvent,
    SessionStatus,
};
use super::utils::{
    get_session_row, get_session_row_or_throw, insert_events_with_incrementing_seq, object,
    session_row, snapshot_of,
};
use crate::stats::util::now_iso;

const DEFAULT_LIST_LIMIT: i64 = 50;
const MAX_LIST_LIMIT: i64 = 200;

pub fn create_session(
    connection: &Connection,
    input: &CreateSessionInput,
) -> Result<CreateSessionResult, AgentV2Error> {
    let id = format!("agent-session-{}", Uuid::new_v4());
    let now = now_iso();
    let status = input.status.unwrap_or(SessionStatus::Idle);

    connection.execute(
        "INSERT INTO agent_v2_sessions (
           id, user_id, conversation_id, status, revision, last_seq, last_error, created_at, updated_at, completed_at
         )
         VALUES (?, ?, ?, ?, 0, 0, NULL, ?, ?, NULL)",
        params![id, input.user_id, input.conversation_id, status.as_str(), now, now],
    )?;

    let row = get_session_row_or_throw(connection, &id, &input.user_id)?;
    let events = insert_events_with_incrementing_seq(
        connection,
        &row,
        None,
        vec![NewEvent {
            event_type: EventType::SessionUpdated,
            payload: object(json!({ "reason": "session_started", "status": status })),
        }],
        &now,
    )?;
    let session = snapshot_of(connection, &row)?;
    Ok(CreateSessionResult { session, events })
}

pub fn get_session(
    connection: &Connection,
    session_id: &str,
    user_id: &str,
) -> Result<Option<AgentSessionSnapshot>, AgentV2Error> {
    get_session_row(connection, session_id, user_id)?
        .map(|row| snapshot_of(connection, &row))
        .transpose()
}

/// `listSessions`: `limit` defaults to 50 and is clamped to 1..=200. `0` counts
/// as "not given", as `limit || 50` does in the TypeScript.
pub fn list_sessions(
    connection: &Connection,
    user_id: &str,
    limit: Option<i64>,
) -> Result<Vec<AgentSessionSnapshot>, AgentV2Error> {
    let limit = limit
        .filter(|value| *value != 0)
        .unwrap_or(DEFAULT_LIST_LIMIT)
        .clamp(1, MAX_LIST_LIMIT);
    let rows = {
        let mut statement = connection.prepare(
            "SELECT * FROM agent_v2_sessions WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?",
        )?;
        let mapped = statement.query_map(params![user_id, limit], session_row)?;
        mapped.collect::<rusqlite::Result<Vec<_>>>()?
    };
    rows.iter()
        .map(|row| snapshot_of(connection, row))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_v2::migrations::run_migrations;

    #[test]
    fn list_limit_defaults_and_clamps() {
        let connection = Connection::open_in_memory().expect("open");
        run_migrations(&connection).expect("migrate");
        for index in 0..3 {
            create_session(
                &connection,
                &CreateSessionInput {
                    user_id: "u".into(),
                    conversation_id: format!("c-{index}"),
                    status: None,
                },
            )
            .expect("create");
        }
        assert_eq!(
            list_sessions(&connection, "u", Some(0))
                .expect("zero")
                .len(),
            3
        );
        assert_eq!(
            list_sessions(&connection, "u", Some(2)).expect("two").len(),
            2
        );
        assert_eq!(
            list_sessions(&connection, "u", Some(-5))
                .expect("neg")
                .len(),
            1
        );
        assert_eq!(
            list_sessions(&connection, "u", None).expect("none").len(),
            3
        );
    }
}
