//! Port of `src/server/agent-v2/repository/commandRepository.ts`.
//!
//! The functions run inside the transaction that the caller opened (see
//! [`super::repository::AgentV2Repository`]).
//!
//! `completeCommand` in the TypeScript also counts the queued commands and passes
//! the count to `resolveSessionStatusAfterCommand`, which ignores it. That count
//! is not read here.

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::json;
use uuid::Uuid;

use super::errors::AgentV2Error;
use super::types::{
    CommandRow, CommandStatus, CompleteCommandInput, CompleteCommandResult,
    EnqueueAgentCommandInput, EnqueueAgentCommandResult, EventType, NewEvent, SessionStatus,
    StartNextCommandResult,
};
use super::utils::{
    build_session_snapshot, command_row, count_queued_commands_unsafe, get_command_or_throw,
    get_command_row_or_throw, get_session_row_or_throw, insert_events_with_incrementing_seq,
    normalize_idempotency_key, object, resolve_session_status_after_command, to_agent_command,
};
use crate::stats::util::now_iso;

pub fn enqueue_command(
    connection: &Connection,
    input: &EnqueueAgentCommandInput,
) -> Result<EnqueueAgentCommandResult, AgentV2Error> {
    get_session_row_or_throw(connection, &input.session_id, &input.user_id)?;
    let idempotency_key = normalize_idempotency_key(input.idempotency_key.as_deref());

    if let Some(key) = &idempotency_key {
        let existing = connection
            .query_row(
                "SELECT * FROM agent_v2_commands
                 WHERE session_id = ? AND command_type = ? AND idempotency_key = ?
                 LIMIT 1",
                params![input.session_id, input.command_type.as_str(), key],
                command_row,
            )
            .optional()?;
        if let Some(row) = existing {
            return Ok(EnqueueAgentCommandResult {
                command: to_agent_command(row),
                reused: true,
                session: build_session_snapshot(connection, &input.session_id, &input.user_id)?,
                events: Vec::new(),
            });
        }
    }

    let command_id = input
        .command_id
        .clone()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| format!("agent-command-{}", Uuid::new_v4()));
    let now = now_iso();

    connection.execute(
        "UPDATE agent_v2_sessions SET revision = revision + 1, updated_at = ?
         WHERE id = ? AND user_id = ?",
        params![now, input.session_id, input.user_id],
    )?;

    connection.execute(
        "INSERT INTO agent_v2_commands (
           id, session_id, command_type, priority, status, payload_json,
           idempotency_key, enqueued_at, started_at, finished_at, error_code, error_message, result_json
         )
         VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, NULL, NULL, NULL, NULL, NULL)",
        params![
            command_id,
            input.session_id,
            input.command_type.as_str(),
            input.priority,
            serde_json::to_string(&input.payload)?,
            idempotency_key,
            now,
        ],
    )?;

    let refreshed = get_session_row_or_throw(connection, &input.session_id, &input.user_id)?;
    let events = insert_events_with_incrementing_seq(
        connection,
        &refreshed,
        Some(command_id.as_str()),
        vec![
            NewEvent {
                event_type: EventType::CommandQueued,
                payload: object(json!({
                    "commandType": input.command_type,
                    "priority": input.priority,
                    "idempotencyKey": idempotency_key,
                })),
            },
            NewEvent {
                event_type: EventType::SessionUpdated,
                payload: object(json!({
                    "reason": "command_queued",
                    "status": refreshed.status,
                })),
            },
        ],
        &now,
    )?;

    Ok(EnqueueAgentCommandResult {
        command: get_command_or_throw(connection, &command_id)?,
        reused: false,
        session: build_session_snapshot(connection, &input.session_id, &input.user_id)?,
        events,
    })
}

pub fn count_queued_commands(
    connection: &Connection,
    session_id: &str,
    user_id: &str,
) -> Result<i64, AgentV2Error> {
    get_session_row_or_throw(connection, session_id, user_id)?;
    count_queued_commands_unsafe(connection, session_id)
}

pub fn has_queued_abort(connection: &Connection, session_id: &str) -> Result<bool, AgentV2Error> {
    let found: Option<String> = connection
        .query_row(
            "SELECT id FROM agent_v2_commands
             WHERE session_id = ? AND status = 'queued' AND command_type = 'abort'
             LIMIT 1",
            [session_id],
            |row| row.get(0),
        )
        .optional()?;
    Ok(found.is_some())
}

/// `startNextQueuedCommand`: the highest priority first, then the oldest. `None`
/// when nothing is queued.
pub fn start_next_queued_command(
    connection: &Connection,
    session_id: &str,
    user_id: &str,
) -> Result<Option<StartNextCommandResult>, AgentV2Error> {
    get_session_row_or_throw(connection, session_id, user_id)?;
    let next = connection
        .query_row(
            "SELECT * FROM agent_v2_commands
             WHERE session_id = ? AND status = 'queued'
             ORDER BY priority DESC, enqueued_at ASC
             LIMIT 1",
            [session_id],
            command_row,
        )
        .optional()?;
    let Some(next) = next else {
        return Ok(None);
    };

    let now = now_iso();
    connection.execute(
        "UPDATE agent_v2_commands SET status = 'running', started_at = ?
         WHERE id = ? AND session_id = ?",
        params![now, next.id, session_id],
    )?;
    connection.execute(
        "UPDATE agent_v2_sessions SET status = 'running', revision = revision + 1, updated_at = ?
         WHERE id = ? AND user_id = ?",
        params![now, session_id, user_id],
    )?;

    let refreshed = get_session_row_or_throw(connection, session_id, user_id)?;
    let events = insert_events_with_incrementing_seq(
        connection,
        &refreshed,
        Some(next.id.as_str()),
        vec![
            NewEvent {
                event_type: EventType::CommandStarted,
                payload: object(json!({
                    "commandType": next.command_type,
                    "startedAt": now,
                })),
            },
            NewEvent {
                event_type: EventType::SessionUpdated,
                payload: object(json!({
                    "reason": "command_started",
                    "status": "running",
                })),
            },
        ],
        &now,
    )?;

    Ok(Some(StartNextCommandResult {
        command: get_command_or_throw(connection, &next.id)?,
        session: build_session_snapshot(connection, session_id, user_id)?,
        events,
    }))
}

pub fn complete_command(
    connection: &Connection,
    input: &CompleteCommandInput,
) -> Result<CompleteCommandResult, AgentV2Error> {
    get_session_row_or_throw(connection, &input.session_id, &input.user_id)?;
    let command: CommandRow =
        get_command_row_or_throw(connection, &input.command_id, &input.session_id)?;
    let now = now_iso();

    let serialized_result = input
        .result
        .as_ref()
        .map(serde_json::to_string)
        .transpose()?;
    connection.execute(
        "UPDATE agent_v2_commands
         SET status = ?, finished_at = ?, error_code = ?, error_message = ?, result_json = ?
         WHERE id = ? AND session_id = ?",
        params![
            input.status.as_str(),
            now,
            input.error_code,
            input.error_message,
            serialized_result,
            input.command_id,
            input.session_id,
        ],
    )?;

    let next_status = resolve_session_status_after_command(input.status);
    let completed_at = matches!(
        next_status,
        SessionStatus::Completed | SessionStatus::Aborted
    )
    .then(|| now.clone());
    connection.execute(
        "UPDATE agent_v2_sessions
         SET status = ?, revision = revision + 1, last_error = ?, updated_at = ?, completed_at = ?
         WHERE id = ? AND user_id = ?",
        params![
            next_status.as_str(),
            input.error_message,
            now,
            completed_at,
            input.session_id,
            input.user_id,
        ],
    )?;

    let refreshed = get_session_row_or_throw(connection, &input.session_id, &input.user_id)?;

    let mut items = Vec::with_capacity(3);
    if matches!(
        input.status,
        CommandStatus::Failed | CommandStatus::FailedRecoverable
    ) {
        items.push(NewEvent {
            event_type: EventType::Error,
            payload: object(json!({
                "commandType": command.command_type,
                "errorCode": input.error_code.as_deref().unwrap_or("COMMAND_FAILED"),
                "message": input.error_message.as_deref().unwrap_or("Command failed."),
            })),
        });
    } else {
        items.push(NewEvent {
            event_type: EventType::CommandCompleted,
            payload: object(json!({
                "commandType": command.command_type,
                "status": input.status,
                "result": input.result,
            })),
        });
    }
    items.push(NewEvent {
        event_type: EventType::SessionUpdated,
        payload: object(json!({
            "reason": "command_completed",
            "status": next_status,
        })),
    });
    if matches!(
        next_status,
        SessionStatus::Completed | SessionStatus::Aborted
    ) {
        items.push(NewEvent {
            event_type: EventType::SessionCompleted,
            payload: object(json!({ "status": next_status })),
        });
    }

    let events = insert_events_with_incrementing_seq(
        connection,
        &refreshed,
        Some(input.command_id.as_str()),
        items,
        &now,
    )?;

    Ok(CompleteCommandResult {
        command: get_command_or_throw(connection, &input.command_id)?,
        session: build_session_snapshot(connection, &input.session_id, &input.user_id)?,
        events,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_v2::errors::ErrorCode;
    use crate::agent_v2::migrations::run_migrations;
    use crate::agent_v2::session_repository::create_session;
    use crate::agent_v2::types::{CommandType, CreateSessionInput, JsonObject};

    #[test]
    fn a_queued_abort_is_visible_until_it_starts() {
        let connection = Connection::open_in_memory().expect("open");
        run_migrations(&connection).expect("migrate");
        let created = create_session(
            &connection,
            &CreateSessionInput {
                user_id: "u".into(),
                conversation_id: "c".into(),
                status: None,
            },
        )
        .expect("create");
        let session_id = created.session.id;
        enqueue_command(
            &connection,
            &EnqueueAgentCommandInput {
                session_id: session_id.clone(),
                user_id: "u".into(),
                command_type: CommandType::Abort,
                priority: 1,
                payload: JsonObject::new(),
                idempotency_key: None,
                command_id: None,
            },
        )
        .expect("enqueue");
        assert!(has_queued_abort(&connection, &session_id).expect("abort probe"));
        assert_eq!(
            count_queued_commands(&connection, &session_id, "u").expect("count"),
            1
        );
        assert_eq!(
            count_queued_commands(&connection, &session_id, "other")
                .unwrap_err()
                .code(),
            Some(ErrorCode::NotFound)
        );
    }
}
