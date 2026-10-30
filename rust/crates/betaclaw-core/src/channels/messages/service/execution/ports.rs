//! Cross-slice contracts of the chat-dispatch service (S8).
//!
//! The shapes of `service/types.ts` (tool results, pending approvals, resolved tool
//! context), of `routing/modelRouting.ts` (`ModelRoutingConfig`), of
//! `dispatchers/ai/types.ts` (`ModelOutcome`) and of `toolManager.ts`
//! (`ToolCallRequest`) are defined once in their own modules and imported here.
//! S8 only depends on the traits below; the implementations belong to:
//!
//! - `ToolManagerPort`:`service/toolManager.ts` (tool context, approvals, exec
//!   approvals in S11).
//! - `ModelToolLoop`:`service/dispatchers/ai/runModelToolLoop.ts` (Agent C).
//! - `SendResponse`:`service/utils/responseHelper.ts` (delivery, WS in Agent E).
//! - `ChatStore` (`service/ports.rs`): `contextBuilder.ts` and `historyManager.ts`.
//! - `SummaryPort`: `service/summaryService.ts`.
//! - `SessionPort`: `sessionManager.ts`.
//! - `PersonaPort`: `personaRepository.ts`.
//! - `AbortController` / `AbortSignal`: the Web `AbortController` of the TS sources.

use std::sync::Arc;

use serde_json::{json, Map, Value};
use tokio::sync::watch;

use crate::channels::messages::service::dispatchers::ai::types::ModelOutcome;
use crate::channels::messages::service::routing::model_routing::ModelRoutingConfig;
use crate::channels::messages::service::tool_manager::ToolCallRequest;
use crate::channels::messages::service::types::{
    PendingToolApproval, ResolvedToolContext, ToolExecutionResult,
};
use crate::messages_store::types::Conversation;
use crate::model_hub::http::BoxFuture;
use crate::model_hub::types::GatewayMessage;

/// Result of an operation that may touch a port.
pub type PortResult<T> = Result<T, PortError>;

/// Failure of a port call.
///
/// `Aborted` is the TypeScript `AbortError` (`error.name === 'AbortError'`), which
/// the subagent executor reports as `Subagent run aborted.` and does not announce.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum PortError {
    #[error("The operation was aborted")]
    Aborted,
    #[error("{0}")]
    Failed(String),
}

impl From<&str> for PortError {
    fn from(message: &str) -> Self {
        PortError::Failed(message.to_string())
    }
}

impl From<String> for PortError {
    fn from(message: String) -> Self {
        PortError::Failed(message)
    }
}

/// `(delta: string) => void` streaming callback.
pub type StreamSink = Arc<dyn Fn(&str) + Send + Sync>;

/// `getConversation(conversationId, userId)` from the TypeScript callers.
pub type ConversationLookup = Arc<dyn Fn(&str, &str) -> Option<Conversation> + Send + Sync>;

/// `resolveConversationWorkspaceCwd(conversation)`.
pub type WorkspaceCwdResolver = Arc<dyn Fn(&Conversation) -> Option<String> + Send + Sync>;

/// `resolveChatModelRouting(conversation)`.
pub type ModelRoutingResolver = Arc<dyn Fn(&Conversation) -> ModelRoutingConfig + Send + Sync>;

/// The part of `ToolManager` that the dispatch service uses.
pub trait ToolManagerPort: Send + Sync {
    /// `pruneExpired` of the pending approval map (`toolManager.ts:31`).
    fn prune_pending_tool_approvals(&self);
    fn get_pending_approval(&self, token: &str) -> Option<PendingToolApproval>;
    fn delete_pending_approval(&self, token: &str) -> bool;
    fn approve_command<'a>(&'a self, command: &'a str) -> BoxFuture<'a, PortResult<()>>;
    fn resolve_tool_context(&self) -> BoxFuture<'_, PortResult<ResolvedToolContext>>;
    fn execute_tool_function_call(
        &self,
        request: ToolCallRequest,
    ) -> BoxFuture<'_, PortResult<ToolExecutionResult>>;

    /// `ToolManager.buildApprovalMetadata` (`toolManager.ts:75-90`). Pure, so it is
    /// shared here instead of being repeated by every adapter.
    fn build_approval_metadata(
        &self,
        pending: &PendingToolApproval,
        prompt: &str,
        extra: Map<String, Value>,
    ) -> Map<String, Value> {
        let mut out = extra;
        let tool_id = pending.tool_id.as_deref().filter(|id| !id.is_empty());
        out.insert("status".into(), json!("approval_required"));
        out.insert("approvalToken".into(), json!(pending.token));
        out.insert("approval_token".into(), json!(pending.token));
        out.insert("approvalPrompt".into(), json!(prompt));
        out.insert("approval_prompt".into(), json!(prompt));
        out.insert("approvalToolId".into(), json!(tool_id));
        out.insert(
            "approvalToolFunction".into(),
            json!(pending.tool_function_name),
        );
        out
    }
}

/// Arguments of one model tool loop run (`RunModelToolLoopParams` without the
/// fields that S8 never sets).
pub struct ModelLoopParams {
    pub conversation: Conversation,
    pub messages: Vec<GatewayMessage>,
    pub model_hub_profile_id: String,
    pub preferred_model_id: Option<String>,
    pub workspace_cwd: Option<String>,
    pub tool_context: ResolvedToolContext,
    pub abort_signal: Option<AbortSignal>,
    pub on_stream_delta: Option<StreamSink>,
}

/// `runModelToolLoop(toolManager, params)`.
pub trait ModelToolLoop: Send + Sync {
    fn run_model_tool_loop<'a>(
        &'a self,
        tools: &'a dyn ToolManagerPort,
        params: ModelLoopParams,
    ) -> BoxFuture<'a, PortResult<ModelOutcome>>;
}

/// Sending side of the TS `AbortController`. Cloning shares the same signal.
#[derive(Clone)]
pub struct AbortController {
    sender: Arc<watch::Sender<bool>>,
}

impl AbortController {
    pub fn new() -> Self {
        let (sender, _) = watch::channel(false);
        Self {
            sender: Arc::new(sender),
        }
    }

    pub fn abort(&self) {
        self.sender.send_replace(true);
    }

    pub fn is_aborted(&self) -> bool {
        *self.sender.borrow()
    }

    pub fn signal(&self) -> AbortSignal {
        AbortSignal {
            receiver: self.sender.subscribe(),
        }
    }
}

impl Default for AbortController {
    fn default() -> Self {
        Self::new()
    }
}

/// Receiving side of an [`AbortController`].
#[derive(Clone)]
pub struct AbortSignal {
    receiver: watch::Receiver<bool>,
}

impl AbortSignal {
    pub fn is_aborted(&self) -> bool {
        *self.receiver.borrow()
    }

    /// Resolves once the controller has aborted. If every controller is gone the
    /// signal can no longer fire, so the future never resolves.
    pub async fn aborted(&mut self) {
        if self.receiver.wait_for(|aborted| *aborted).await.is_err() {
            std::future::pending::<()>().await;
        }
    }
}
