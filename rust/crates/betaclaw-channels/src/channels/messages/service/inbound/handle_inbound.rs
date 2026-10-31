//! Port of `src/server/channels/messages/service/inbound/handleInbound.ts`.
//!
//! Pipeline: create context, bridge the user message to the world model, optional
//! response correlation, command routing, prepare dispatch, model dispatch.
//!
//! The `finally` of the source runs on every path, including the duplicate-request
//! error. That error path removes the in-flight marker of the first request, which
//! the TypeScript code does too. The port keeps it, and the report flags it.

use std::sync::Arc;

use serde_json::{json, Value};

use crate::channels::messages::service::conversation::ports::{MessageRepositoryPort, SessionPort};
use crate::channels::messages::service::core::types::{lock, ServiceState};
use crate::channels::messages::service::dispatchers::skills_prompt::SkillMdPort;
use crate::channels::messages::service::execution::ports::PortResult;
use crate::channels::messages::service::inbound::stages::create_inbound_context_stage::create_inbound_context_stage;
use crate::channels::messages::service::inbound::stages::dispatch_model_stage::{
    dispatch_model_stage, DispatchModelStageInput,
};
use crate::channels::messages::service::inbound::stages::prepare_dispatch_stage::{
    prepare_dispatch_stage, PrepareDispatchOutcome,
};
use crate::channels::messages::service::inbound::stages::route_command_stage::route_command_stage;
use crate::channels::messages::service::ports::{
    ApprovalResponder, ChatEvents, ChatStore, CommandPort, CorrelateInput, ExecutionPort,
    HandlersPort, ModelGateway, PersonaPort, RecallPort, RecordObservationInput, SendResponse,
    UserMessageOptions, WorldModelPort,
};
use crate::channels::messages::service::summary_service::SummaryService;
use crate::channels::messages::service::tool_manager::ToolManager;
use crate::messages_store::types::{now_iso, ChannelType, Conversation, StoredMessage};
use crate::model_hub::env::EnvOverrides;
use crate::model_hub::openai_compatible::StreamDeltaCallback;

/// Everything the inbound pipeline uses (`HandleInboundDeps`, `handleInbound.ts:30-61`).
#[derive(Clone)]
pub struct InboundDeps {
    pub repo: Arc<dyn MessageRepositoryPort>,
    /// `sessionManager`: conversation lookup and creation.
    pub session: Arc<dyn SessionPort>,
    /// `historyManager` and `contextBuilder`.
    pub chat: Arc<dyn ChatStore>,
    pub events: Arc<dyn ChatEvents>,
    pub world_model: Arc<dyn WorldModelPort>,
    pub personas: Arc<dyn PersonaPort>,
    pub recall: Arc<dyn RecallPort>,
    pub skills: Arc<dyn SkillMdPort>,
    pub model: Arc<dyn ModelGateway>,
    pub summary: Arc<SummaryService>,
    pub tools: Arc<ToolManager>,
    pub commands: Arc<dyn CommandPort>,
    pub approvals: Arc<dyn ApprovalResponder>,
    pub handlers: Arc<dyn HandlersPort>,
    pub execution: Arc<dyn ExecutionPort>,
    pub send: Arc<dyn SendResponse>,
    pub state: Arc<ServiceState>,
    pub env: Arc<EnvOverrides>,
}

/// Options of one inbound call (`opts` of `handleInbound`).
#[derive(Clone, Default)]
pub struct InboundOptions {
    pub skip_project_guard: bool,
    pub execution_directive: Option<String>,
    pub max_tool_calls: Option<i64>,
    pub require_tool_call: bool,
}

/// Arguments of `handleInbound` (`HandleInboundParams`).
#[derive(Clone)]
pub struct InboundParams {
    pub platform: ChannelType,
    pub external_chat_id: String,
    pub content: String,
    pub sender_name: Option<String>,
    pub external_msg_id: Option<String>,
    pub user_id: Option<String>,
    pub client_message_id: Option<String>,
    /// `buildMessageAttachmentMetadata(attachments)`, computed by the caller.
    pub attachment_metadata: Option<Value>,
    pub on_stream_delta: Option<StreamDeltaCallback>,
    pub opts: InboundOptions,
}

impl InboundParams {
    /// User-message options of `appendUserMessage` (`createInboundContextStage.ts:49-54`).
    pub fn user_message_options(&self) -> UserMessageOptions {
        UserMessageOptions {
            external_msg_id: self.external_msg_id.clone(),
            sender_name: self.sender_name.clone(),
            client_message_id: self.client_message_id.clone(),
            metadata: self.attachment_metadata.clone(),
        }
    }
}

/// Result of one inbound turn: `{ userMsg, agentMsg, newConversationId? }`.
#[derive(Debug, Clone, PartialEq)]
pub struct InboundResult {
    pub user_msg: StoredMessage,
    pub agent_msg: StoredMessage,
    pub new_conversation_id: Option<String>,
}

/// `handleInboundMessage(deps, params)` (`handleInbound.ts:81-193`).
pub async fn handle_inbound_message(
    deps: &InboundDeps,
    params: InboundParams,
) -> PortResult<InboundResult> {
    let outcome = run_pipeline(deps, &params).await;

    // `finally { if (clientMessageId) processingMessages.delete(clientMessageId) }`
    if let Some(client_message_id) = &params.client_message_id {
        lock(&deps.state.processing_messages).remove(client_message_id);
    }
    outcome
}

async fn run_pipeline(deps: &InboundDeps, params: &InboundParams) -> PortResult<InboundResult> {
    let context = create_inbound_context_stage(deps, params)?;
    let effective = &context.effective_conversation;

    // The persisted message id is the canonical source identity for the bridge.
    deps.events
        .bridge_stored_message(effective.clone(), context.user_msg.clone())
        .await?;

    if deps.world_model.looks_like_response(&params.content) {
        correlate_inbound(deps, params, &context.user_msg, effective).await?;
    }

    let routed = route_command_stage(
        deps,
        &context.route,
        &context.user_msg,
        effective,
        params,
        context.tools_disabled_for_persona,
    )
    .await?;
    if let Some(result) = routed {
        return Ok(result);
    }

    let prepared = prepare_dispatch_stage(
        deps,
        params,
        &context.user_msg,
        effective,
        context.tools_disabled_for_persona,
    )
    .await?;
    match prepared {
        PrepareDispatchOutcome::Done(result) => Ok(*result),
        PrepareDispatchOutcome::Continue {
            effective_user_input,
            project_created_from_clarification,
        } => {
            dispatch_model_stage(
                deps,
                params,
                DispatchModelStageInput {
                    user_msg: &context.user_msg,
                    effective,
                    active_persona: context.active_persona.as_ref(),
                    tools_disabled: context.tools_disabled_for_persona,
                    effective_user_input: &effective_user_input,
                    project_created_from_clarification: project_created_from_clarification
                        .as_deref(),
                },
            )
            .await
        }
    }
}

/// World-model response correlation (`handleInbound.ts:98-153`). A failed observation
/// is fatal only in required mode. A failed correlation is logged.
async fn correlate_inbound(
    deps: &InboundDeps,
    params: &InboundParams,
    user_msg: &StoredMessage,
    effective: &Conversation,
) -> PortResult<()> {
    let flags = deps.world_model.flags();
    let Some(persona_id) = effective.persona_id.clone() else {
        return Ok(());
    };
    if !(flags.enabled || flags.e2e_enabled) {
        return Ok(());
    }

    let source_id = user_msg.id.clone();
    let mut observation_id: Option<String> = None;
    let observation = deps
        .world_model
        .record_observation(RecordObservationInput {
            user_id: effective.user_id.clone(),
            persona_id,
            workspace_id: effective.workspace_id.clone().unwrap_or_default(),
            source_type: "chat_message",
            source_id: source_id.clone(),
            occurred_at: now_iso(),
            payload: json!({
                "conversationId": effective.id,
                "seq": user_msg.seq,
                "role": "user",
                "text": params.content,
                "channelType": params.platform.as_str(),
                "externalChatId": params.external_chat_id,
                "externalMsgId": params.external_msg_id,
            }),
            source_authority: "user",
        })
        .await;
    match observation {
        Ok(id) => observation_id = Some(id),
        Err(error) => {
            if flags.required {
                return Err(error);
            }
            eprintln!("[world-model:correlation] inbound observation failed: {error}");
        }
    }

    if let Err(error) = deps
        .world_model
        .correlate_inbound_response(CorrelateInput {
            conversation: effective.clone(),
            text: params.content.clone(),
            received_at: now_iso(),
            observation_id,
            source_id,
        })
        .await
    {
        eprintln!("[world-model:correlation] inbound correlation failed: {error}");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_message_options_carry_the_inbound_fields() {
        let params = InboundParams {
            platform: ChannelType::Telegram,
            external_chat_id: "chat".into(),
            content: "hi".into(),
            sender_name: Some("Max".into()),
            external_msg_id: Some("ext-1".into()),
            user_id: None,
            client_message_id: Some("client-1".into()),
            attachment_metadata: Some(json!({"attachments": []})),
            on_stream_delta: None,
            opts: InboundOptions::default(),
        };
        let options = params.user_message_options();
        assert_eq!(options.sender_name.as_deref(), Some("Max"));
        assert_eq!(options.client_message_id.as_deref(), Some("client-1"));
        assert_eq!(options.metadata, Some(json!({"attachments": []})));
    }
}
