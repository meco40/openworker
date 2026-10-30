//! Port of `src/server/channels/messages/service/inbound/stages/createInboundContextStage.ts`.
//!
//! Order matters here, as in the source: the conversation is looked up before the
//! duplicate check, so a duplicate still creates the conversation. The user message is
//! persisted and published before the channel-binding persona is applied.

use crate::channels::messages::service::core::tool_policy::are_tools_disabled_for_persona;
use crate::channels::messages::service::core::types::lock;
use crate::channels::messages::service::execution::ports::{PortError, PortResult};
use crate::channels::messages::service::inbound::handle_inbound::{InboundDeps, InboundParams};
use crate::channels::messages::service::ports::RouteResult;
use crate::messages_store::types::{Conversation, StoredMessage};
use crate::personas::types::PersonaProfile;

/// Output of the context stage (`CreateInboundContextResult`).
pub struct InboundContext {
    pub conversation: Conversation,
    pub user_msg: StoredMessage,
    pub effective_conversation: Conversation,
    pub active_persona: Option<PersonaProfile>,
    pub tools_disabled_for_persona: bool,
    pub route: RouteResult,
}

/// `createInboundContextStage(deps, params)` (`createInboundContextStage.ts:21-81`).
pub fn create_inbound_context_stage(
    deps: &InboundDeps,
    params: &InboundParams,
) -> PortResult<InboundContext> {
    let conversation = deps.session.get_or_create_conversation(
        params.platform,
        &params.external_chat_id,
        None,
        params.user_id.as_deref(),
    )?;

    if let Some(client_message_id) = &params.client_message_id {
        let mut processing = lock(&deps.state.processing_messages);
        if processing.contains(client_message_id) {
            return Err(PortError::from("Duplicate request — already processing"));
        }
        processing.insert(client_message_id.clone());
    }

    let user_msg = deps.chat.append_user_message(
        &conversation.id,
        params.platform,
        &params.content,
        params.user_message_options(),
    )?;
    deps.events.message_persisted(&conversation, &user_msg);
    deps.events
        .broadcast_chat_message(&conversation.user_id, &user_msg);
    deps.events.inbox_upserted(&conversation, &user_msg);

    let effective_conversation = deps
        .chat
        .apply_channel_binding_persona(&conversation, params.platform)?;
    let active_persona = match effective_conversation.persona_id.as_deref() {
        Some(persona_id) => deps.personas.get_persona(persona_id)?,
        None => None,
    };
    let tools_disabled_for_persona = are_tools_disabled_for_persona(active_persona.as_ref());

    Ok(InboundContext {
        conversation,
        user_msg,
        effective_conversation,
        active_persona,
        tools_disabled_for_persona,
        route: deps.commands.route_message(&params.content),
    })
}
