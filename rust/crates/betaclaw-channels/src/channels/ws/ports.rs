//! Ports for the WS handlers.
//!
//! The handlers reach the TypeScript services only through these traits. Each
//! trait names the TypeScript module it stands in for. The owning slices supply
//! the implementations: the dispatch agents (C, D) implement [`MessageService`],
//! the repository agent (F) implements [`MessageStore`], and the other ports
//! follow their TypeScript owners. Fallible calls return [`HandlerError`], so a
//! port failure reaches the wire with the code a thrown TypeScript error gets.

use std::future::Future;
use std::pin::Pin;

use crate::channels::messages::service::execution::ports::StreamSink;
use serde_json::Value;

use super::helpers::HandlerError;

/// Boxed future for the async ports. Same shape as `model_hub::http::BoxFuture`.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// The conversation fields the WS handlers read (`Conversation` in TypeScript).
#[derive(Debug, Clone, PartialEq)]
pub struct ConversationView {
    pub id: String,
    pub channel_type: String,
    pub title: String,
    pub updated_at: String,
    pub persona_id: Option<String>,
}

/// Input to `persistIncomingAttachment` (`channels/messages/attachments.ts`).
#[derive(Debug, Clone, PartialEq)]
pub struct IncomingAttachment {
    pub user_id: String,
    pub conversation_id: String,
    pub persona_slug: Option<String>,
    pub name: String,
    pub mime_type: String,
    pub size: u64,
    pub data_url: String,
}

/// Input to `service.handleWebUIMessage`.
#[derive(Debug, Clone, PartialEq)]
pub struct WebUiMessage {
    pub conversation_id: String,
    pub content: String,
    pub user_id: String,
    pub client_message_id: Option<String>,
    /// Records returned by [`MessageService::persist_incoming_attachment`].
    pub attachments: Option<Vec<Value>>,
}

/// Result of `service.handleWebUIMessage`.
#[derive(Debug, Clone, PartialEq)]
pub struct WebUiResult {
    pub user_msg_id: String,
    pub agent_msg_id: String,
    pub new_conversation_id: Option<String>,
}

/// Input to `service.respondToolApproval`.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolApproval {
    pub conversation_id: String,
    pub user_id: String,
    pub approval_token: String,
    pub approved: bool,
    pub approve_always: bool,
    pub tool_id: Option<String>,
    pub tool_function_name: Option<String>,
}

/// Dispatch side of the messages service (`getMessageService()`).
/// Implemented by the dispatch agents (C, D).
pub trait MessageService: Send + Sync {
    /// `service.getConversation(id, userId)`.
    fn get_conversation(
        &self,
        conversation_id: &str,
        user_id: &str,
    ) -> Result<Option<ConversationView>, HandlerError>;

    /// `service.setPersonaId(id, personaId, userId)`.
    fn set_persona_id(
        &self,
        conversation_id: &str,
        persona_id: &str,
        user_id: &str,
    ) -> Result<(), HandlerError>;

    /// `service.getOrCreateConversation(channelType, externalId, title, userId)`.
    fn get_or_create_conversation(
        &self,
        channel_type: &str,
        external_id: &str,
        title: Option<&str>,
        user_id: &str,
    ) -> Result<ConversationView, HandlerError>;

    /// `service.deleteConversation(id, userId)`.
    fn delete_conversation(
        &self,
        conversation_id: &str,
        user_id: &str,
    ) -> Result<bool, HandlerError>;

    /// `service.setModelOverride(id, override, userId)`. `None` clears the override.
    fn set_model_override(
        &self,
        conversation_id: &str,
        model_override: Option<&str>,
        user_id: &str,
    ) -> Result<(), HandlerError>;

    /// `service.abortGeneration(id)`.
    fn abort_generation(&self, conversation_id: &str) -> Result<bool, HandlerError>;

    /// `persistIncomingAttachment(...)`. Returns the stored attachment record.
    fn persist_incoming_attachment(
        &self,
        attachment: IncomingAttachment,
    ) -> Result<Value, HandlerError>;

    /// `service.handleWebUIMessage(...)`. `on_delta` gets native deltas only and is
    /// `None` for `chat.send`.
    fn handle_web_ui_message(
        &self,
        message: WebUiMessage,
        on_delta: Option<StreamSink>,
    ) -> BoxFuture<'_, Result<WebUiResult, HandlerError>>;

    /// `service.respondToolApproval(...)`. The result is passed through unchanged.
    fn respond_tool_approval<'a>(
        &'a self,
        approval: ToolApproval,
    ) -> BoxFuture<'a, Result<Value, HandlerError>>;
}

/// A row of `listChannelBindings` (`channel_bindings` in the repository).
#[derive(Debug, Clone, PartialEq)]
pub struct ChannelBinding {
    pub channel: String,
    pub status: Option<String>,
    pub peer_name: Option<String>,
    pub transport: Option<String>,
    pub last_seen_at: Option<String>,
}

/// Input to `upsertChannelBinding`.
#[derive(Debug, Clone, PartialEq)]
pub struct ChannelBindingWrite {
    pub user_id: String,
    pub channel: String,
    pub status: String,
    pub peer_name: Option<String>,
    pub transport: Option<String>,
    pub metadata: Option<Value>,
}

/// Read and write side of the message repository. Implemented by agent F.
pub trait MessageStore: Send + Sync {
    /// `repo.listMessages(conversationId, limit, before, userId)`.
    fn list_messages(
        &self,
        conversation_id: &str,
        limit: i64,
        before: Option<&str>,
        user_id: &str,
    ) -> Result<Vec<Value>, HandlerError>;

    /// `repo.listConversations(limit, userId)`.
    fn list_conversations(&self, limit: usize, user_id: &str) -> Result<Vec<Value>, HandlerError>;

    /// `repo.listChannelBindings(userId)`.
    fn list_channel_bindings(&self, user_id: &str) -> Result<Vec<ChannelBinding>, HandlerError>;

    /// `repo.upsertChannelBinding(...)`.
    fn upsert_channel_binding(&self, binding: ChannelBindingWrite) -> Result<(), HandlerError>;
}

/// The persona fields the handlers read (`getPersona` in `personaRepository.ts`).
#[derive(Debug, Clone, PartialEq)]
pub struct PersonaRecord {
    pub slug: Option<String>,
}

/// Persona lookup.
pub trait PersonaStore: Send + Sync {
    /// `getPersonaRepository().getPersona(id)`, limited to personas owned by `user_id`.
    /// TypeScript reads any persona by id; the owner check is a deliberate deviation
    /// (OP-28), because a foreign persona id would otherwise bind to the caller's chat.
    fn find_persona(
        &self,
        persona_id: &str,
        user_id: &str,
    ) -> Result<Option<PersonaRecord>, HandlerError>;
}

/// Channel pairing and bridge accounts (`channels/pairing`).
pub trait ChannelPairing: Send + Sync {
    /// `listBridgeAccounts(channel)`. Only called for whatsapp and imessage.
    fn list_bridge_accounts(&self, channel: &str) -> Result<Value, HandlerError>;

    /// `pairChannel(channel, token, accountId)`. The raw result is returned, and the
    /// handler reads the optional fields the way the TypeScript does.
    fn pair_channel<'a>(
        &'a self,
        channel: &'a str,
        token: &'a str,
        account_id: Option<&'a str>,
    ) -> BoxFuture<'a, Result<Value, HandlerError>>;

    /// `unpairChannel(channel, accountId)`.
    fn unpair_channel<'a>(
        &'a self,
        channel: &'a str,
        account_id: Option<&'a str>,
    ) -> BoxFuture<'a, Result<(), HandlerError>>;
}

/// Input to `manager.startSession`.
#[derive(Debug, Clone, PartialEq)]
pub struct StartSession {
    pub user_id: String,
    pub title: Option<String>,
    pub persona_id: Option<String>,
    pub conversation_id: Option<String>,
}

/// The `{ session, events }` result of `manager.startSession`.
#[derive(Debug, Clone, PartialEq)]
pub struct StartedSession {
    pub session: Value,
    pub events: Value,
}

/// The operation that `manager.enqueue*` is asked to perform.
#[derive(Debug, Clone, PartialEq)]
pub enum SessionCommandKind {
    /// `enqueueInput`, `content`.
    Input(String),
    /// `enqueueSteer`, `instruction`.
    Steer(String),
    /// `enqueueFollowUp`, `content`.
    FollowUp(String),
    /// `enqueueApprovalResponse`.
    ApprovalResponse {
        approval_token: String,
        approved: bool,
        approve_always: bool,
        tool_id: Option<String>,
        tool_function_name: Option<String>,
    },
    /// `enqueueAbort`, `reason`.
    Abort { reason: Option<String> },
}

/// Input to one of the `enqueue*` methods.
#[derive(Debug, Clone, PartialEq)]
pub struct SessionCommand {
    pub session_id: String,
    pub user_id: String,
    pub kind: SessionCommandKind,
    pub idempotency_key: Option<String>,
    /// Caller-chosen id for input and follow-up commands, as the swarm dispatcher passes it.
    pub command_id: Option<String>,
}

/// The `{ command, session }` result of an `enqueue*` method.
#[derive(Debug, Clone, PartialEq)]
pub struct CommandResult {
    pub command: Value,
    pub session: Value,
}

/// Input to `manager.replaySessionEvents`.
#[derive(Debug, Clone, PartialEq)]
pub struct ReplayRequest {
    pub session_id: String,
    pub user_id: String,
    pub from_seq: f64,
    pub limit: Option<u64>,
}

/// Agent-v2 session manager (`getAgentV2SessionManager()`). Agent-v2 is S12 in the
/// plan. This port only covers the handler logic.
pub trait AgentV2Sessions: Send + Sync {
    fn start_session<'a>(
        &'a self,
        input: StartSession,
    ) -> BoxFuture<'a, Result<StartedSession, HandlerError>>;

    /// Dispatches to `enqueueInput`, `enqueueSteer`, `enqueueFollowUp`,
    /// `enqueueApprovalResponse` or `enqueueAbort`, depending on `command.kind`.
    fn enqueue<'a>(
        &'a self,
        command: SessionCommand,
    ) -> BoxFuture<'a, Result<CommandResult, HandlerError>>;

    /// `manager.getSession(sessionId, userId)`.
    fn get_session(&self, session_id: &str, user_id: &str) -> Result<Option<Value>, HandlerError>;

    /// `manager.listSessions(userId, limit)`.
    fn list_sessions(&self, user_id: &str, limit: u64) -> Result<Vec<Value>, HandlerError>;

    /// `manager.replaySessionEvents(...)`.
    fn replay_events(&self, request: ReplayRequest) -> Result<Vec<Value>, HandlerError>;

    fn get_command_result(
        &self,
        command_id: &str,
        session_id: &str,
        user_id: &str,
    ) -> Result<Option<Value>, HandlerError>;
}

/// Sends a gateway event to every connection of one user (`broadcastToUser`).
pub trait EventSink: Send + Sync {
    fn broadcast_to_user(&self, user_id: &str, event: &str, payload: Value);
}
