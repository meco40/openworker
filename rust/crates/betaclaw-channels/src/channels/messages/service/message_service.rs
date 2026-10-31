//! Port of `src/server/channels/messages/service/messageService.ts` (`MessageService` facade).
//!
//! Partial port, by design. This file holds the methods with logic of their own, and the
//! delegations whose targets belong to this slice: inbound handling, inbox reads, model
//! and persona setters, the summary refresh, and the approval and subagent-tool
//! entry points. The pass-throughs to `conversation/` and `maintenance/` (Agent D),
//! `handlers/webUIHandler` and `orchestration/runSubagent` (Agents A/B) are not ported
//! here, because those modules are not in this slice.
//!
//! The `listInbox` fallback that runs when the repository lacks `listInbox` is not
//! ported: [`MessageRepositoryPort`] always provides it, so only the repository path is reachable.

use std::sync::Arc;

use crate::channels::messages::service::approval::handler::{ApprovalOutcome, ApprovalParams};
use crate::channels::messages::service::execution::ports::PortResult;
use crate::channels::messages::service::inbound::handle_inbound::{
    handle_inbound_message, InboundDeps, InboundParams, InboundResult,
};
use crate::channels::messages::service::ports::{SubagentToolCallParams, SubagentToolInvoker};
use crate::messages_store::types::{
    Conversation, InboxItemRecord, InboxListInput, InboxListResult,
};
use serde_json::Value;

/// The facade. It holds the inbound dependencies and the two delegation targets.
pub struct MessageService {
    inbound: InboundDeps,
    subagent_tools: Arc<dyn SubagentToolInvoker>,
}

impl MessageService {
    pub fn new(inbound: InboundDeps, subagent_tools: Arc<dyn SubagentToolInvoker>) -> Self {
        Self {
            inbound,
            subagent_tools,
        }
    }

    /// `handleInbound(...)`.
    pub async fn handle_inbound(&self, params: InboundParams) -> PortResult<InboundResult> {
        handle_inbound_message(&self.inbound, params).await
    }

    /// `listInbox(input)`, repository path (`messageService.ts:187-208`).
    pub fn list_inbox(&self, input: &InboxListInput<'_>) -> PortResult<InboxListResult> {
        self.inbound.repo.list_inbox(input)
    }

    /// `getInboxItem(conversationId, userId)`, repository path (`messageService.ts:295-297`).
    pub fn get_inbox_item(
        &self,
        conversation_id: &str,
        user_id: &str,
    ) -> PortResult<Option<InboxItemRecord>> {
        self.inbound.repo.get_inbox_item(conversation_id, user_id)
    }

    /// `setModelOverride(conversationId, modelOverride, userId)` (`messageService.ts:513-515`).
    pub fn set_model_override(
        &self,
        conversation_id: &str,
        model_override: Option<&str>,
        user_id: &str,
    ) -> PortResult<()> {
        self.inbound
            .repo
            .update_model_override(conversation_id, model_override, user_id)
    }

    /// `setPersonaId(conversationId, personaId, userId)` (`messageService.ts:517-519`).
    pub fn set_persona_id(
        &self,
        conversation_id: &str,
        persona_id: Option<&str>,
        user_id: &str,
    ) -> PortResult<()> {
        self.inbound
            .repo
            .update_persona_id(conversation_id, persona_id, user_id)
    }

    /// `maybeRefreshConversationSummary(conversation)` (`messageService.ts:509-511`).
    pub async fn maybe_refresh_conversation_summary(
        &self,
        conversation: &Conversation,
    ) -> PortResult<()> {
        self.inbound
            .summary
            .maybe_refresh_conversation_summary(conversation)
            .await
    }

    /// `respondToolApproval(params)` (`messageService.ts:406-435`).
    pub async fn respond_tool_approval(
        &self,
        params: ApprovalParams,
    ) -> PortResult<ApprovalOutcome> {
        self.inbound.approvals.respond_tool_approval(params).await
    }

    /// `invokeSubagentToolCall(params)` (`messageService.ts:387-404`).
    pub async fn invoke_subagent_tool_call(
        &self,
        params: SubagentToolCallParams,
    ) -> PortResult<Value> {
        self.subagent_tools.invoke(params).await
    }
}
