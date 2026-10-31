//! Port of `src/server/channels/messages/service/inbound/stages/prepareDispatchStage.ts`.
//!
//! Checks that can answer the turn without the model, in source order: project
//! clarification reply, memory feedback (fire-and-forget), memory save, project
//! clarification request, inferred shell question, strict evidence recall. If none
//! applies, the turn continues to the model dispatch.

use crate::channels::messages::service::core::project_management::{
    maybe_consume_project_clarification_reply, maybe_request_project_clarification,
    ClarificationOutcome, ProjectDeps,
};
use crate::channels::messages::service::execution::ports::PortResult;
use crate::channels::messages::service::inbound::handle_inbound::{
    InboundDeps, InboundParams, InboundResult,
};
use crate::channels::messages::service::ports::{MemorySaveInput, ShellInferenceInput};
use crate::channels::messages::service::routing::model_routing::is_memory_enabled_for_conversation;
use crate::channels::messages::service::subagent::utils::object;
use crate::channels::messages::service::types::infer_shell_command_from_natural_language;
use crate::messages_store::types::{Conversation, StoredMessage};

/// What the stage decided (`PrepareDispatchStageResult`).
#[derive(Debug, Clone, PartialEq)]
pub enum PrepareDispatchOutcome {
    /// The turn goes on to the model. `effective_user_input` may be the replayed task.
    Continue {
        effective_user_input: String,
        project_created_from_clarification: Option<String>,
    },
    /// The turn ended here with this reply.
    Done(Box<InboundResult>),
}

/// `prepareDispatchStage(input)` (`prepareDispatchStage.ts:28-130`).
pub async fn prepare_dispatch_stage(
    deps: &InboundDeps,
    params: &InboundParams,
    user_msg: &StoredMessage,
    effective: &Conversation,
    tools_disabled_for_persona: bool,
) -> PortResult<PrepareDispatchOutcome> {
    let platform = params.platform;
    let chat_id = params.external_chat_id.as_str();
    let memory_enabled = is_memory_enabled_for_conversation(effective, &*deps.repo)?;

    let mut effective_user_input = params.content.clone();
    let mut project_created_from_clarification: Option<String> = None;

    let project_deps = ProjectDeps {
        repo: &*deps.repo,
        personas: &*deps.personas,
        send: &*deps.send,
        pending: &deps.state.pending_project_clarifications,
    };

    match maybe_consume_project_clarification_reply(
        &project_deps,
        effective,
        platform,
        chat_id,
        &params.content,
    )
    .await?
    {
        Some(ClarificationOutcome::Message(message)) => {
            return Ok(done(user_msg, message));
        }
        Some(ClarificationOutcome::Replay {
            replay_task_input,
            project_name,
        }) => {
            effective_user_input = replay_task_input;
            project_created_from_clarification = Some(project_name);
        }
        None => {}
    }

    if memory_enabled {
        deps.recall
            .maybe_learn_from_feedback(effective.clone(), params.content.clone());
    }

    let memory_save = deps
        .handlers
        .handle_memory_save(
            MemorySaveInput {
                conversation: effective.clone(),
                content: params.content.clone(),
                platform,
                external_chat_id: chat_id.to_string(),
                memory_enabled,
            },
            deps.send.clone(),
        )
        .await?;
    if let Some(message) = memory_save {
        return Ok(done(user_msg, message));
    }

    let project_message = if params.opts.skip_project_guard {
        None
    } else {
        maybe_request_project_clarification(
            &project_deps,
            effective,
            platform,
            chat_id,
            &effective_user_input,
        )
        .await?
    };
    if let Some(message) = project_message {
        return Ok(done(user_msg, message));
    }

    let inferred_command =
        infer_shell_command_from_natural_language(&effective_user_input, cfg!(windows));
    if let Some(command) = inferred_command.filter(|_| !tools_disabled_for_persona) {
        let message = deps
            .handlers
            .handle_inferred_shell_question(
                ShellInferenceInput {
                    conversation: effective.clone(),
                    platform,
                    external_chat_id: chat_id.to_string(),
                    user_input: effective_user_input.clone(),
                    command,
                    on_stream_delta: params.on_stream_delta.clone(),
                },
                deps.send.clone(),
            )
            .await?;
        return Ok(done(user_msg, message));
    }

    if memory_enabled {
        let strict = deps
            .recall
            .build_strict_evidence_reply(effective.clone(), effective_user_input.clone())
            .await?;
        if let Some(reply) = strict {
            let message = deps
                .send
                .send_response(
                    effective,
                    &reply.content,
                    platform,
                    chat_id,
                    reply.metadata.map(object),
                )
                .await?;
            return Ok(done(user_msg, message));
        }
    }

    Ok(PrepareDispatchOutcome::Continue {
        effective_user_input,
        project_created_from_clarification,
    })
}

fn done(user_msg: &StoredMessage, agent_msg: StoredMessage) -> PrepareDispatchOutcome {
    PrepareDispatchOutcome::Done(Box::new(InboundResult {
        user_msg: user_msg.clone(),
        agent_msg,
        new_conversation_id: None,
    }))
}
