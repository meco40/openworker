//! Port of `src/server/agent-v2/session/commands/enqueue.ts`.
//!
//! The builders take the TypeScript arguments and return the repository input. In
//! TypeScript each builder calls `enqueueCommand` through a callback. Here the caller
//! passes the built input to [`enqueue_command`].
//!
//! [`enqueue_command`] keeps the TypeScript order: session lookup, queue capacity,
//! `command.before_enqueue` (a callback here), then the write. The event broadcast and
//! the queue kick are the runtime's. The caller does them after the call, from the
//! result. It kicks the queue only when `reused` is false.

use std::collections::HashMap;

use serde_json::json;

use crate::agent_v2::errors::{AgentV2Error, ErrorCode};
use crate::agent_v2::repository::AgentV2Repository;
use crate::agent_v2::session::constants::{
    QUEUE_PRIORITY_ABORT, QUEUE_PRIORITY_APPROVAL, QUEUE_PRIORITY_FOLLOW_UP, QUEUE_PRIORITY_INPUT,
    QUEUE_PRIORITY_STEER,
};
use crate::agent_v2::session::state::update::get_session;
use crate::agent_v2::session::types::AgentSessionHandle;
use crate::agent_v2::session::utils::resolve_max_queue_length;
use crate::agent_v2::types::{
    AgentSessionSnapshot, CommandType, EnqueueAgentCommandInput, EnqueueAgentCommandResult,
    JsonObject,
};
use crate::agent_v2::utils::object;

/// `enqueueCommand`. `before_enqueue` receives the session as it was before the write and
/// the input, as the `command.before_enqueue` hook does. The hook is synchronous here.
pub fn enqueue_command(
    repository: &AgentV2Repository,
    active_handles: &mut HashMap<String, AgentSessionHandle>,
    input: &EnqueueAgentCommandInput,
    before_enqueue: impl FnOnce(&AgentSessionSnapshot, &EnqueueAgentCommandInput),
) -> Result<EnqueueAgentCommandResult, AgentV2Error> {
    let current = get_session(
        repository,
        active_handles,
        &input.session_id,
        &input.user_id,
    )?;
    ensure_queue_capacity(
        repository,
        &input.session_id,
        &input.user_id,
        max_queue_length(),
    )?;
    before_enqueue(&current, input);

    let enqueued = repository.enqueue_command(input)?;
    active_handles.insert(
        input.session_id.clone(),
        AgentSessionHandle {
            session_id: input.session_id.clone(),
            user_id: input.user_id.clone(),
            snapshot: enqueued.session.clone(),
        },
    );
    Ok(enqueued)
}

/// `ensureQueueCapacity`. Fails with `BACKPRESSURE` when the session already has
/// `max_queue` queued commands.
pub fn ensure_queue_capacity(
    repository: &AgentV2Repository,
    session_id: &str,
    user_id: &str,
    max_queue: i64,
) -> Result<(), AgentV2Error> {
    let current = repository.count_queued_commands(session_id, user_id)?;
    if current >= max_queue {
        return Err(AgentV2Error::new(
            ErrorCode::Backpressure,
            format!("Session command queue is full ({max_queue})."),
        ));
    }
    Ok(())
}

/// `enqueueInput`.
pub fn input_command(
    session_id: &str,
    user_id: &str,
    content: &str,
    idempotency_key: Option<&str>,
    command_id: Option<&str>,
) -> EnqueueAgentCommandInput {
    command_input(
        session_id,
        user_id,
        CommandType::Input,
        QUEUE_PRIORITY_INPUT,
        object(json!({ "content": content })),
        idempotency_key,
        command_id,
    )
}

/// `enqueueSteer`. The TypeScript never passes a command id for a steer.
pub fn steer_command(
    session_id: &str,
    user_id: &str,
    instruction: &str,
    idempotency_key: Option<&str>,
) -> EnqueueAgentCommandInput {
    command_input(
        session_id,
        user_id,
        CommandType::Steer,
        QUEUE_PRIORITY_STEER,
        object(json!({ "content": instruction })),
        idempotency_key,
        None,
    )
}

/// `enqueueFollowUp`.
pub fn follow_up_command(
    session_id: &str,
    user_id: &str,
    content: &str,
    idempotency_key: Option<&str>,
    command_id: Option<&str>,
) -> EnqueueAgentCommandInput {
    command_input(
        session_id,
        user_id,
        CommandType::FollowUp,
        QUEUE_PRIORITY_FOLLOW_UP,
        object(json!({ "content": content })),
        idempotency_key,
        command_id,
    )
}

/// `enqueueApprovalResponse`. An empty `tool_id` or `tool_function_name` is stored as
/// null, as `x || null` does in TypeScript. The approve-always flag is the caller's
/// `Boolean(...)`. The TypeScript never passes a command id for an approval.
#[allow(clippy::too_many_arguments)]
pub fn approval_command(
    session_id: &str,
    user_id: &str,
    approval_token: &str,
    approved: bool,
    approve_always: bool,
    tool_id: Option<&str>,
    tool_function_name: Option<&str>,
    idempotency_key: Option<&str>,
) -> EnqueueAgentCommandInput {
    command_input(
        session_id,
        user_id,
        CommandType::Approval,
        QUEUE_PRIORITY_APPROVAL,
        object(json!({
            "approvalToken": approval_token,
            "approved": approved,
            "approveAlways": approve_always,
            "toolId": non_empty(tool_id),
            "toolFunctionName": non_empty(tool_function_name),
        })),
        idempotency_key,
        None,
    )
}

/// `enqueueAbort`. An empty reason is replaced by `Abort requested.`.
pub fn abort_command(
    session_id: &str,
    user_id: &str,
    reason: Option<&str>,
    idempotency_key: Option<&str>,
) -> EnqueueAgentCommandInput {
    command_input(
        session_id,
        user_id,
        CommandType::Abort,
        QUEUE_PRIORITY_ABORT,
        object(json!({ "reason": non_empty(reason).unwrap_or("Abort requested.") })),
        idempotency_key,
        None,
    )
}

/// `process.env.AGENT_V2_MAX_QUEUE_PER_SESSION`, read at each enqueue as the TypeScript does.
fn max_queue_length() -> i64 {
    resolve_max_queue_length(
        std::env::var("AGENT_V2_MAX_QUEUE_PER_SESSION")
            .ok()
            .as_deref(),
    )
}

fn non_empty(value: Option<&str>) -> Option<&str> {
    value.filter(|text| !text.is_empty())
}

fn command_input(
    session_id: &str,
    user_id: &str,
    command_type: CommandType,
    priority: i64,
    payload: JsonObject,
    idempotency_key: Option<&str>,
    command_id: Option<&str>,
) -> EnqueueAgentCommandInput {
    EnqueueAgentCommandInput {
        session_id: session_id.into(),
        user_id: user_id.into(),
        command_type,
        priority,
        payload,
        idempotency_key: idempotency_key.map(str::to_string),
        command_id: command_id.map(str::to_string),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_v2::types::CreateSessionInput;

    fn session(repository: &AgentV2Repository, user: &str) -> String {
        repository
            .create_session(&CreateSessionInput {
                user_id: user.into(),
                conversation_id: "conv".into(),
                status: None,
            })
            .expect("create session")
            .session
            .id
    }

    #[test]
    fn builders_carry_the_typescript_priorities_and_payloads() {
        let input = input_command("s", "u", "hi", None, Some("cmd-1"));
        assert_eq!(input.command_type, CommandType::Input);
        assert_eq!(input.priority, QUEUE_PRIORITY_INPUT);
        assert_eq!(input.payload["content"], "hi");
        assert_eq!(input.command_id.as_deref(), Some("cmd-1"));

        let follow_up = follow_up_command("s", "u", "more", None, Some("cmd-2"));
        assert_eq!(follow_up.priority, QUEUE_PRIORITY_FOLLOW_UP);
        assert_eq!(follow_up.command_id.as_deref(), Some("cmd-2"));

        let steer = steer_command("s", "u", "stop", Some("k"));
        assert_eq!(steer.priority, QUEUE_PRIORITY_STEER);
        assert_eq!(steer.command_id, None);
        assert_eq!(steer.idempotency_key.as_deref(), Some("k"));

        let approval = approval_command("s", "u", "tok", true, false, Some(""), None, None);
        assert_eq!(approval.priority, QUEUE_PRIORITY_APPROVAL);
        assert_eq!(approval.payload["approvalToken"], "tok");
        assert_eq!(approval.payload["approved"], true);
        assert_eq!(approval.payload["approveAlways"], false);
        assert!(approval.payload["toolId"].is_null());
        assert!(approval.payload["toolFunctionName"].is_null());

        let abort = abort_command("s", "u", Some(""), None);
        assert_eq!(abort.priority, QUEUE_PRIORITY_ABORT);
        assert_eq!(abort.payload["reason"], "Abort requested.");
    }

    #[test]
    fn queue_capacity_rejects_a_full_queue() {
        let repository = AgentV2Repository::in_memory().expect("open");
        let session_id = session(&repository, "u");
        repository
            .enqueue_command(&input_command(&session_id, "u", "a", None, None))
            .expect("enqueue");
        repository
            .enqueue_command(&steer_command(&session_id, "u", "b", None))
            .expect("enqueue");

        ensure_queue_capacity(&repository, &session_id, "u", 3).expect("below the limit");
        let error = ensure_queue_capacity(&repository, &session_id, "u", 2).expect_err("full");
        assert_eq!(error.code(), Some(ErrorCode::Backpressure));
        assert_eq!(error.to_string(), "Session command queue is full (2).");
    }

    #[test]
    fn enqueue_runs_the_hook_before_the_write_and_caches_the_session() {
        let repository = AgentV2Repository::in_memory().expect("open");
        let session_id = session(&repository, "u");
        let mut handles = HashMap::new();
        let mut hooked = Vec::new();

        let enqueued = enqueue_command(
            &repository,
            &mut handles,
            &input_command(&session_id, "u", "hi", None, None),
            |session, input| hooked.push((session.id.clone(), input.command_type)),
        )
        .expect("enqueue");

        assert_eq!(hooked, vec![(session_id.clone(), CommandType::Input)]);
        assert_eq!(enqueued.command.command_type, CommandType::Input);
        assert_eq!(handles[&session_id].snapshot, enqueued.session);
    }

    #[test]
    fn enqueue_refuses_another_users_session_before_the_hook() {
        let repository = AgentV2Repository::in_memory().expect("open");
        let session_id = session(&repository, "owner");
        let mut handles = HashMap::new();
        let mut hooked = false;

        let error = enqueue_command(
            &repository,
            &mut handles,
            &input_command(&session_id, "stranger", "hi", None, None),
            |_, _| hooked = true,
        )
        .expect_err("not the owner");

        assert_eq!(error.code(), Some(ErrorCode::NotFound));
        assert!(!hooked);
        assert!(handles.is_empty());
    }
}
