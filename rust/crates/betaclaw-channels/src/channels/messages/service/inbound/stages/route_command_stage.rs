//! Port of `src/server/channels/messages/service/inbound/stages/routeCommandStage.ts`.
//!
//! Slash-style commands end the turn here. Shell and subagent commands are refused for
//! roleplay personas, which get a fixed reply instead.

use serde_json::json;

use crate::channels::messages::service::subagent::utils::object;

use crate::channels::messages::service::core::project_management::get_project_clarification_key;
use crate::channels::messages::service::core::tool_policy::ROLEPLAY_TOOLS_DISABLED_MESSAGE;
use crate::channels::messages::service::core::types::lock;
use crate::channels::messages::service::execution::ports::PortResult;
use crate::channels::messages::service::inbound::handle_inbound::{
    InboundDeps, InboundParams, InboundResult,
};
use crate::channels::messages::service::ports::{
    CommandInput, CommandKind, NewConversation, RouteResult, RouteTarget,
};
use crate::channels::messages::service::tool_manager::now_ms;
use crate::messages_store::types::{Conversation, StoredMessage};

/// Routes a command message (`routeCommandStage`, `routeCommandStage.ts:32-181`).
/// `Ok(None)` means the message is not a command and continues in the pipeline.
pub async fn route_command_stage(
    deps: &InboundDeps,
    route: &RouteResult,
    user_msg: &StoredMessage,
    effective: &Conversation,
    params: &InboundParams,
    tools_disabled_for_persona: bool,
) -> PortResult<Option<InboundResult>> {
    let platform = params.platform;
    let chat_id = params.external_chat_id.as_str();

    match route.target {
        RouteTarget::None => Ok(None),

        RouteTarget::SessionCommand => {
            let new_conversation = deps.repo.create_conversation(&NewConversation {
                channel_type: platform,
                external_chat_id: Some(format!(
                    "manual-{}-{}",
                    params
                        .user_id
                        .as_deref()
                        .filter(|id| !id.is_empty())
                        .unwrap_or("local"),
                    now_ms()
                )),
                title: route.payload.clone().filter(|title| !title.is_empty()),
                user_id: Some(effective.user_id.clone()),
            })?;
            let agent_msg = deps
                .send
                .send_response(
                    effective,
                    "✨ Neue Konversation erstellt.",
                    platform,
                    chat_id,
                    None,
                )
                .await?;
            Ok(Some(InboundResult {
                user_msg: user_msg.clone(),
                agent_msg,
                new_conversation_id: Some(new_conversation.id),
            }))
        }

        RouteTarget::AutomationCommand => {
            let agent_msg =
                run_command(deps, CommandKind::Automation, route, effective, params).await?;
            Ok(Some(plain(user_msg, agent_msg)))
        }

        RouteTarget::PersonaCommand => {
            let agent_msg =
                run_command(deps, CommandKind::Persona, route, effective, params).await?;
            Ok(Some(plain(user_msg, agent_msg)))
        }

        RouteTarget::ProjectCommand => {
            lock(&deps.state.pending_project_clarifications)
                .remove(&get_project_clarification_key(effective));
            let agent_msg =
                run_command(deps, CommandKind::Project, route, effective, params).await?;
            Ok(Some(plain(user_msg, agent_msg)))
        }

        RouteTarget::ApprovalCommand => {
            let agent_msg =
                run_command(deps, CommandKind::Approval, route, effective, params).await?;
            Ok(Some(plain(user_msg, agent_msg)))
        }

        RouteTarget::ShellCommand => {
            if tools_disabled_for_persona {
                let agent_msg = refuse_roleplay(deps, user_msg, effective, params).await?;
                return Ok(Some(agent_msg));
            }
            let agent_msg = run_command(deps, CommandKind::Shell, route, effective, params).await?;
            Ok(Some(plain(user_msg, agent_msg)))
        }

        RouteTarget::SubagentCommand => {
            if tools_disabled_for_persona {
                let agent_msg = refuse_roleplay(deps, user_msg, effective, params).await?;
                return Ok(Some(agent_msg));
            }
            let agent_msg =
                run_command(deps, CommandKind::Subagent, route, effective, params).await?;
            Ok(Some(plain(user_msg, agent_msg)))
        }
    }
}

/// Runs one command handler with the shared dependencies of the command module.
async fn run_command(
    deps: &InboundDeps,
    kind: CommandKind,
    route: &RouteResult,
    effective: &Conversation,
    params: &InboundParams,
) -> PortResult<StoredMessage> {
    deps.commands
        .handle_command(
            kind,
            CommandInput {
                conversation: effective.clone(),
                platform: params.platform,
                external_chat_id: params.external_chat_id.clone(),
                payload: route.payload.clone(),
                command: route.command.clone(),
                send: deps.send.clone(),
                repo: deps.repo.clone(),
                approvals: deps.approvals.clone(),
            },
        )
        .await
}

/// The fixed reply for tool-using commands in roleplay personas.
async fn refuse_roleplay(
    deps: &InboundDeps,
    user_msg: &StoredMessage,
    effective: &Conversation,
    params: &InboundParams,
) -> PortResult<InboundResult> {
    let agent_msg = deps
        .send
        .send_response(
            effective,
            ROLEPLAY_TOOLS_DISABLED_MESSAGE,
            params.platform,
            &params.external_chat_id,
            Some(object(
                json!({"ok": false, "status": "tools_disabled_for_roleplay"}),
            )),
        )
        .await?;
    Ok(plain(user_msg, agent_msg))
}

fn plain(user_msg: &StoredMessage, agent_msg: StoredMessage) -> InboundResult {
    InboundResult {
        user_msg: user_msg.clone(),
        agent_msg,
        new_conversation_id: None,
    }
}
