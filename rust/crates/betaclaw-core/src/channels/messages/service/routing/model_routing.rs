//! Port of `src/server/channels/messages/service/routing/modelRouting.ts`.
//!
//! `process.env.MODEL_HUB_PROFILE_ID` becomes an [`EnvOverrides`] argument. The
//! persona lookup keeps the TypeScript `try/catch`: a failing persona store does not
//! block routing, so a `PortError` is ignored.

use crate::channels::messages::service::conversation::ports::MessageRepositoryPort;
use crate::channels::messages::service::execution::ports::PortResult;
use crate::channels::messages::service::ports::PersonaPort;
use crate::messages_store::types::{ChannelType, Conversation};
use crate::model_hub::env::EnvOverrides;

/// `ModelRoutingConfig` (`modelRouting.ts:13-16`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelRoutingConfig {
    pub preferred_model_id: Option<String>,
    pub model_hub_profile_id: String,
}

/// `resolveChatModelRouting(conversation)` (`modelRouting.ts:21-43`).
///
/// Precedence: conversation override, then persona preferred model; profile from the
/// persona, then `MODEL_HUB_PROFILE_ID`, then `p1`. Empty strings count as unset,
/// as in the `!x` and `x?.trim()` checks of the source.
pub fn resolve_chat_model_routing(
    conversation: &Conversation,
    personas: &dyn PersonaPort,
    env: &EnvOverrides,
) -> ModelRoutingConfig {
    let mut preferred_model_id = conversation.model_override.clone();
    let mut model_hub_profile_id = env
        .get("MODEL_HUB_PROFILE_ID")
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "p1".to_string());

    if let Some(persona_id) = conversation.persona_id.as_deref() {
        // Persona storage should not block model routing.
        if let Ok(Some(persona)) = personas.get_persona(persona_id) {
            let preferred_is_unset = preferred_model_id.as_deref().is_none_or(str::is_empty);
            if preferred_is_unset {
                if let Some(model) = persona.preferred_model_id.filter(|m| !m.is_empty()) {
                    preferred_model_id = Some(model);
                }
            }
            if let Some(profile) = persona.model_hub_profile_id.as_deref().map(str::trim) {
                if !profile.is_empty() {
                    model_hub_profile_id = profile.to_string();
                }
            }
        }
    }

    ModelRoutingConfig {
        preferred_model_id,
        model_hub_profile_id,
    }
}

/// `isAgentRoomConversationRecord(conversation, repo)` (`modelRouting.ts:48-57`).
pub fn is_agent_room_conversation_record(
    conversation: &Conversation,
    repo: &dyn MessageRepositoryPort,
) -> PortResult<bool> {
    if ChannelType::parse(&conversation.channel_type) == Some(ChannelType::AgentRoom) {
        return Ok(true);
    }
    repo.is_agent_room_conversation(&conversation.id, Some(&conversation.user_id))
}

/// `isMemoryEnabledForConversation(conversation, repo)` (`modelRouting.ts:62-67`).
/// Memory is off for agent rooms.
pub fn is_memory_enabled_for_conversation(
    conversation: &Conversation,
    repo: &dyn MessageRepositoryPort,
) -> PortResult<bool> {
    Ok(!is_agent_room_conversation_record(conversation, repo)?)
}
