//! Port of `src/server/agent-v2/repository/recoveryRepository.ts`.
//!
//! Run once at startup. Every command still `running` belongs to a process that
//! is gone, so it is marked `failed_recoverable` and its session goes to
//! `error_recoverable`.

use std::collections::HashSet;

use rusqlite::{params, Connection};

use serde_json::json;

use super::errors::AgentV2Error;
use super::types::{EventType, NewEvent, RecoveryResult};
use super::utils::{get_session_row_or_throw, insert_events_with_incrementing_seq, object};
use crate::stats::util::now_iso;

pub fn recover_running_commands_on_startup(
    connection: &Connection,
) -> Result<RecoveryResult, AgentV2Error> {
    let running: Vec<(String, String, String)> = {
        let mut statement = connection.prepare(
            "SELECT c.id AS command_id, c.session_id, s.user_id
             FROM agent_v2_commands c
             INNER JOIN agent_v2_sessions s ON s.id = c.session_id
             WHERE c.status = 'running'",
        )?;
        let mapped = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?;
        mapped.collect::<rusqlite::Result<Vec<_>>>()?
    };

    if running.is_empty() {
        return Ok(RecoveryResult {
            recovered_commands: 0,
            touched_sessions: 0,
        });
    }

    let now = now_iso();
    let mut touched_sessions = HashSet::new();
    for (command_id, session_id, user_id) in &running {
        touched_sessions.insert(session_id.clone());
        connection.execute(
            "UPDATE agent_v2_commands
             SET status = 'failed_recoverable',
                 finished_at = ?,
                 error_code = 'RECOVERED_ON_BOOT',
                 error_message = 'Command marked recoverable after process restart.'
             WHERE id = ?",
            params![now, command_id],
        )?;

        get_session_row_or_throw(connection, session_id, user_id)?;
        connection.execute(
            "UPDATE agent_v2_sessions
             SET status = 'error_recoverable', revision = revision + 1, last_error = ?, updated_at = ?
             WHERE id = ? AND user_id = ?",
            params![
                "Recovered running command on startup.",
                now,
                session_id,
                user_id,
            ],
        )?;

        let refreshed = get_session_row_or_throw(connection, session_id, user_id)?;
        insert_events_with_incrementing_seq(
            connection,
            &refreshed,
            Some(command_id.as_str()),
            vec![
                NewEvent {
                    event_type: EventType::Error,
                    payload: object(json!({
                        "errorCode": "RECOVERED_ON_BOOT",
                        "message": "Running command was marked failed_recoverable during startup recovery.",
                    })),
                },
                NewEvent {
                    event_type: EventType::SessionUpdated,
                    payload: object(json!({
                        "reason": "startup_recovery",
                        "status": "error_recoverable",
                    })),
                },
            ],
            &now,
        )?;
    }

    Ok(RecoveryResult {
        recovered_commands: running.len(),
        touched_sessions: touched_sessions.len(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_v2::command_repository::{enqueue_command, start_next_queued_command};
    use crate::agent_v2::migrations::run_migrations;
    use crate::agent_v2::session_repository::create_session;
    use crate::agent_v2::types::{
        CommandType, CreateSessionInput, EnqueueAgentCommandInput, JsonObject,
    };

    #[test]
    fn running_commands_are_marked_recoverable_and_counted_once_per_row() {
        let connection = Connection::open_in_memory().expect("open");
        run_migrations(&connection).expect("migrate");
        let session_id = create_session(
            &connection,
            &CreateSessionInput {
                user_id: "u".into(),
                conversation_id: "c".into(),
                status: None,
            },
        )
        .expect("create")
        .session
        .id;
        enqueue_command(
            &connection,
            &EnqueueAgentCommandInput {
                session_id: session_id.clone(),
                user_id: "u".into(),
                command_type: CommandType::Input,
                priority: 100,
                payload: JsonObject::new(),
                idempotency_key: None,
                command_id: None,
            },
        )
        .expect("enqueue");
        start_next_queued_command(&connection, &session_id, "u").expect("start");

        let result = recover_running_commands_on_startup(&connection).expect("recover");
        assert_eq!(result.recovered_commands, 1);
        assert_eq!(result.touched_sessions, 1);

        let again = recover_running_commands_on_startup(&connection).expect("second run");
        assert_eq!(again.recovered_commands, 0);
    }
}
