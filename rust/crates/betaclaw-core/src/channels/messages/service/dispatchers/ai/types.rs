//! Port of `src/server/channels/messages/service/dispatchers/ai/types.ts`.

use serde_json::{Map, Value};

use crate::channels::messages::service::types::ResolvedToolContext;
use crate::messages_store::types::{ChannelType, Conversation};
use crate::model_hub::http::AbortSignal;
use crate::model_hub::openai_compatible::StreamDeltaCallback;
use crate::model_hub::types::GatewayMessage;

/// `DispatchMessage` (`ai/types.ts:4-7`). The model-hub message type carries the same
/// `role` and `content`, so one type serves both sides.
pub type DispatchMessage = GatewayMessage;

/// `ModelOutcome.metadata` (`ai/types.ts:15-18`).
pub type OutcomeMetadata = Map<String, Value>;

/// `ModelOutcome` (`ai/types.ts:15-18`).
#[derive(Debug, Clone, PartialEq)]
pub struct ModelOutcome {
    pub content: String,
    pub metadata: OutcomeMetadata,
}

/// Audit extras of a dispatch (`ai/types.ts:30`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AuditContextExtras {
    pub turn_seq: Option<i64>,
    pub memory_context: Option<String>,
}

/// `RunModelToolLoopParams` (`ai/types.ts:20-31`).
#[derive(Clone)]
pub struct RunModelToolLoopParams {
    pub conversation: Conversation,
    pub messages: Vec<DispatchMessage>,
    pub model_hub_profile_id: String,
    pub preferred_model_id: Option<String>,
    pub workspace_cwd: Option<String>,
    pub tool_context: ResolvedToolContext,
    pub max_tool_calls: Option<i64>,
    pub abort_signal: Option<AbortSignal>,
    pub on_stream_delta: Option<StreamDeltaCallback>,
    pub audit_context_extras: AuditContextExtras,
}

/// `DispatchToAIParams` (`ai/types.ts:33-45`).
#[derive(Clone)]
pub struct DispatchToAiParams {
    pub conversation: Conversation,
    pub platform: ChannelType,
    pub external_chat_id: String,
    pub user_input: String,
    pub on_stream_delta: Option<StreamDeltaCallback>,
    pub turn_seq: Option<i64>,
    pub execution_directive: Option<String>,
    pub max_tool_calls: Option<i64>,
    pub skip_summary_refresh: bool,
    pub require_tool_call: bool,
    pub tools_disabled: bool,
}
