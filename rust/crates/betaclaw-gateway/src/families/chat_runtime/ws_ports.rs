//! The chat runtime as the ports of the WS method family.
//!
//! Port of the `messageService.ts` entry points that `src/server/gateway/methods/`
//! calls: the conversation accessors and the maintenance operations of
//! `maintenance/operations.ts` ([`WsMessages`]), the repository reads of
//! `sqliteMessageRepository.ts` ([`WsStore`]) and the persona lookup of
//! `personaRepository.ts` ([`WsPersonas`]). `handlers/webUIHandler.ts` backs
//! `handle_web_ui_message`.
//!
//! The attachment files come from the channel family's production store
//! (`channels_wire::attachments`), the same type the channel routes use. Only that
//! port is shared; the chat runtime holds no other channel state.

use std::sync::{Arc, PoisonError};

use betaclaw_core::channels::messages::service::approval::handler::ApprovalParams;
use betaclaw_core::channels::messages::service::conversation::ports::SessionPort;
use betaclaw_core::channels::messages::service::core::types::ServiceState;
use betaclaw_core::channels::messages::service::execution::ports::{PortError, StreamSink};
use betaclaw_core::channels::messages::service::handlers::web_ui_handler::{
    handle_web_ui_message, InboundPort, InboundRequest, WebUiHandlerDeps, WebUiMessageParams,
    WebUiMessageResult,
};
use betaclaw_core::channels::messages::service::inbound::handle_inbound::{
    InboundParams, InboundResult,
};
use betaclaw_core::channels::messages::service::message_service::MessageService;
use betaclaw_core::channels::messages::service::ports::{RecallPort, SummaryPort};
use betaclaw_core::channels::ws::helpers::HandlerError;
use betaclaw_core::channels::ws::ports::{
    ChannelBinding, ChannelBindingWrite, ConversationView, IncomingAttachment,
    MessageService as WsMessageService, MessageStore, PersonaRecord, PersonaStore, ToolApproval,
    WebUiMessage, WebUiResult,
};
use betaclaw_core::gateway::protocol::ErrorCode;
use betaclaw_core::messages_store::types::{ChannelType, Conversation};
use betaclaw_core::messages_store::UpsertChannelBindingInput;
use betaclaw_core::model_hub::http::BoxFuture;
use serde_json::{json, Value};

use super::persona::PersonaStore as ChatPersonas;
use super::repo::{MessagesRepo, SessionManager};
use super::to_i64;

/// Any port failure, as the wire code the handlers send. A failed repository call has
/// no `code`, so it maps to UNAVAILABLE like a thrown TypeScript error.
fn port_error(error: PortError) -> HandlerError {
    HandlerError::new(ErrorCode::Unavailable, error.to_string())
}

fn to_value<T: serde::Serialize>(record: T) -> Result<Value, HandlerError> {
    serde_json::to_value(record)
        .map_err(|error| HandlerError::new(ErrorCode::Unavailable, error.to_string()))
}

/// `Conversation` as the WS handlers read it (`ConversationView`).
fn conversation_view(conversation: Conversation) -> ConversationView {
    ConversationView {
        id: conversation.id,
        channel_type: conversation.channel_type,
        title: conversation.title,
        updated_at: conversation.updated_at,
        persona_id: conversation.persona_id,
    }
}

/// The dispatch as `handleWebUIMessage` sees it: `handle_inbound` with the request
/// fields the handler passes through.
struct WebUiInbound(Arc<MessageService>);

impl InboundPort for WebUiInbound {
    fn handle_inbound<'a>(
        &'a self,
        request: InboundRequest,
    ) -> BoxFuture<'a, Result<WebUiMessageResult, PortError>> {
        Box::pin(async move {
            let result = self
                .0
                .handle_inbound(InboundParams {
                    platform: request.platform,
                    external_chat_id: request.external_chat_id,
                    content: request.content,
                    sender_name: None,
                    external_msg_id: None,
                    user_id: Some(request.user_id),
                    client_message_id: request.client_message_id,
                    // `buildMessageAttachmentMetadata`: an empty list is `undefined`.
                    attachment_metadata: request
                        .attachments
                        .filter(|records| !records.is_empty())
                        .map(|records| json!({ "attachments": records })),
                    on_stream_delta: request.on_stream_delta,
                    opts: request.opts.unwrap_or_default(),
                })
                .await?;
            let InboundResult {
                user_msg,
                agent_msg,
                new_conversation_id,
            } = result;
            Ok(WebUiMessageResult {
                user_msg,
                agent_msg,
                new_conversation_id,
            })
        })
    }
}

/// `messageService.ts` as the WS family's `MessageService` port.
pub struct WsMessages {
    service: Arc<MessageService>,
    inbound: Arc<dyn InboundPort>,
    repo: Arc<MessagesRepo>,
    session: Arc<SessionManager>,
    state: Arc<ServiceState>,
    summary: Arc<dyn SummaryPort>,
    recall: Arc<dyn RecallPort>,
    attachments: Arc<super::super::channels_wire::attachments::AttachmentStore>,
}

impl WsMessages {
    #[allow(clippy::too_many_arguments)]
    pub(super) fn new(
        service: Arc<MessageService>,
        repo: Arc<MessagesRepo>,
        session: Arc<SessionManager>,
        state: Arc<ServiceState>,
        summary: Arc<dyn SummaryPort>,
        recall: Arc<dyn RecallPort>,
        attachments: Arc<super::super::channels_wire::attachments::AttachmentStore>,
    ) -> Self {
        let inbound: Arc<dyn InboundPort> = Arc::new(WebUiInbound(service.clone()));
        Self {
            service,
            inbound,
            repo,
            session,
            state,
            summary,
            recall,
            attachments,
        }
    }

    /// `abortGeneration(this.state.activeRequests, conversationId)`.
    fn abort_active(&self, conversation_id: &str) -> bool {
        let mut active = self
            .state
            .active_requests
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        match active.remove(conversation_id) {
            Some(signal) => {
                signal.abort();
                true
            }
            None => false,
        }
    }
}

impl WsMessageService for WsMessages {
    fn get_conversation(
        &self,
        conversation_id: &str,
        user_id: &str,
    ) -> Result<Option<ConversationView>, HandlerError> {
        self.repo
            .run(|store| store.get_conversation(conversation_id, Some(user_id)))
            .map(|found| found.map(conversation_view))
            .map_err(port_error)
    }

    fn set_persona_id(
        &self,
        conversation_id: &str,
        persona_id: &str,
        user_id: &str,
    ) -> Result<(), HandlerError> {
        self.service
            .set_persona_id(conversation_id, Some(persona_id), user_id)
            .map_err(port_error)
    }

    fn get_or_create_conversation(
        &self,
        channel_type: &str,
        external_id: &str,
        title: Option<&str>,
        user_id: &str,
    ) -> Result<ConversationView, HandlerError> {
        let channel = ChannelType::parse(channel_type).ok_or_else(|| {
            HandlerError::invalid(format!("Unknown channel type: {channel_type}"))
        })?;
        self.session
            .get_or_create_conversation(channel, external_id, title, Some(user_id))
            .map(conversation_view)
            .map_err(port_error)
    }

    fn delete_conversation(
        &self,
        conversation_id: &str,
        user_id: &str,
    ) -> Result<bool, HandlerError> {
        // `deleteConversation` (`operations.ts:41-51`): abort, clear the caches, delete.
        self.abort_active(conversation_id);
        self.summary.clear_in_flight(conversation_id);
        self.recall.clear_conversation_state(conversation_id);
        self.repo
            .run(|store| store.delete_conversation(conversation_id, user_id))
            .map_err(port_error)
    }

    fn set_model_override(
        &self,
        conversation_id: &str,
        model_override: Option<&str>,
        user_id: &str,
    ) -> Result<(), HandlerError> {
        self.service
            .set_model_override(conversation_id, model_override, user_id)
            .map_err(port_error)
    }

    fn abort_generation(&self, conversation_id: &str) -> Result<bool, HandlerError> {
        Ok(self.abort_active(conversation_id))
    }

    fn persist_incoming_attachment(
        &self,
        attachment: IncomingAttachment,
    ) -> Result<Value, HandlerError> {
        let stored = self
            .attachments
            .persist(
                &attachment.user_id,
                &attachment.conversation_id,
                attachment.persona_slug.as_deref(),
                &super::super::channels_wire::attachments::IncomingAttachment {
                    name: attachment.name,
                    mime_type: attachment.mime_type,
                    size: attachment.size,
                    data_url: attachment.data_url,
                },
            )
            .map_err(|error| HandlerError::new(ErrorCode::Unavailable, error))?;
        to_value(stored)
    }

    fn handle_web_ui_message(
        &self,
        message: WebUiMessage,
        on_delta: Option<StreamSink>,
    ) -> BoxFuture<'_, Result<WebUiResult, HandlerError>> {
        Box::pin(async move {
            let deps = WebUiHandlerDeps {
                session: self.session.clone(),
                inbound: self.inbound.clone(),
            };
            let params = WebUiMessageParams {
                conversation_id: message.conversation_id,
                content: message.content,
                user_id: Some(message.user_id),
                client_message_id: message.client_message_id,
                attachments: message.attachments,
                on_stream_delta: on_delta,
                opts: None,
            };
            let result = handle_web_ui_message(&deps, params)
                .await
                .map_err(port_error)?;
            Ok(WebUiResult {
                user_msg_id: result.user_msg.id,
                agent_msg_id: result.agent_msg.id,
                new_conversation_id: result.new_conversation_id,
            })
        })
    }

    fn respond_tool_approval<'a>(
        &'a self,
        approval: ToolApproval,
    ) -> BoxFuture<'a, Result<Value, HandlerError>> {
        Box::pin(async move {
            let outcome = self
                .service
                .respond_tool_approval(ApprovalParams {
                    conversation_id: approval.conversation_id,
                    user_id: approval.user_id,
                    approval_token: approval.approval_token,
                    approved: approval.approved,
                    approve_always: approval.approve_always,
                    tool_id: approval.tool_id,
                    tool_function_name: approval.tool_function_name,
                })
                .await
                .map_err(port_error)?;
            Ok(json!({
                "ok": outcome.ok,
                "status": outcome.status.as_str(),
                "policyUpdated": outcome.policy_updated,
            }))
        })
    }
}

/// `messageRepository` reads (`sqliteMessageRepository.ts`).
pub struct WsStore {
    repo: Arc<MessagesRepo>,
}

impl WsStore {
    pub(super) fn new(repo: Arc<MessagesRepo>) -> Self {
        Self { repo }
    }
}

impl MessageStore for WsStore {
    fn list_messages(
        &self,
        conversation_id: &str,
        limit: i64,
        before: Option<&str>,
        user_id: &str,
    ) -> Result<Vec<Value>, HandlerError> {
        self.repo
            .run(|store| store.list_messages(conversation_id, limit, before, Some(user_id)))
            .map_err(port_error)?
            .into_iter()
            .map(to_value)
            .collect()
    }

    fn list_conversations(&self, limit: usize, user_id: &str) -> Result<Vec<Value>, HandlerError> {
        self.repo
            .run(|store| store.list_conversations(to_i64(limit), Some(user_id)))
            .map_err(port_error)?
            .into_iter()
            .map(to_value)
            .collect()
    }

    fn list_channel_bindings(&self, user_id: &str) -> Result<Vec<ChannelBinding>, HandlerError> {
        self.repo
            .run(|store| store.list_channel_bindings(user_id))
            .map_err(port_error)
            .map(|bindings| {
                bindings
                    .into_iter()
                    .map(|binding| ChannelBinding {
                        channel: binding.channel,
                        status: Some(binding.status),
                        peer_name: binding.peer_name,
                        transport: binding.transport,
                        last_seen_at: binding.last_seen_at,
                    })
                    .collect()
            })
    }

    fn upsert_channel_binding(&self, binding: ChannelBindingWrite) -> Result<(), HandlerError> {
        let metadata = binding.metadata;
        self.repo
            .run(|store| {
                store.upsert_channel_binding(&UpsertChannelBindingInput {
                    user_id: &binding.user_id,
                    channel: &binding.channel,
                    status: &binding.status,
                    external_peer_id: None,
                    peer_name: binding.peer_name.as_deref(),
                    transport: binding.transport.as_deref(),
                    metadata: metadata.as_ref(),
                })
            })
            .map(|_| ())
            .map_err(port_error)
    }
}

/// `getPersonaRepository().getPersona(id)` (`personaRepository.ts`).
pub struct WsPersonas {
    personas: Arc<ChatPersonas>,
}

impl WsPersonas {
    pub(super) fn new(personas: Arc<ChatPersonas>) -> Self {
        Self { personas }
    }
}

impl PersonaStore for WsPersonas {
    fn find_persona(
        &self,
        persona_id: &str,
        user_id: &str,
    ) -> Result<Option<PersonaRecord>, HandlerError> {
        self.personas
            .run(|repository| repository.get_persona(persona_id))
            .map_err(port_error)
            .map(|found| {
                found
                    .filter(|profile| profile.user_id == user_id)
                    .map(|profile| PersonaRecord {
                        slug: Some(profile.slug),
                    })
            })
    }
}

#[cfg(test)]
mod tests {
    use super::super::test_support::Scratch;
    use super::*;
    use betaclaw_core::messages_store::types::{MessageRole, SaveMessageInput};

    #[test]
    fn the_store_port_serves_conversations_messages_and_bindings() {
        let scratch = Scratch::new();
        let repo = Arc::new(MessagesRepo::open(&scratch.path("messages.db")).expect("open"));
        let store = WsStore::new(repo.clone());
        let user = "user-ws";
        let conversation = repo
            .run(|s| s.get_or_create_conversation("WebChat", "web-ws", None, Some(user)))
            .expect("conversation");
        repo.run(|s| {
            s.save_message(&SaveMessageInput {
                conversation_id: &conversation.id,
                role: MessageRole::User,
                content: "hallo",
                platform: "WebChat",
                external_msg_id: None,
                sender_name: None,
                metadata: None,
                client_message_id: None,
            })
        })
        .expect("save");

        let messages = store
            .list_messages(&conversation.id, 50, None, user)
            .expect("messages");
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0]["content"], "hallo");

        let conversations = store.list_conversations(50, user).expect("conversations");
        assert_eq!(conversations.len(), 1);
        assert_eq!(conversations[0]["id"], conversation.id);

        store
            .upsert_channel_binding(ChannelBindingWrite {
                user_id: user.into(),
                channel: "telegram".into(),
                status: "connected".into(),
                peer_name: Some("peer".into()),
                transport: Some("webhook".into()),
                metadata: Some(json!({ "accountId": "default" })),
            })
            .expect("upsert");
        let bindings = store.list_channel_bindings(user).expect("bindings");
        assert_eq!(bindings.len(), 1);
        assert_eq!(bindings[0].channel, "telegram");
        assert_eq!(bindings[0].status.as_deref(), Some("connected"));
        assert_eq!(bindings[0].peer_name.as_deref(), Some("peer"));
    }

    #[test]
    fn the_persona_port_reports_a_missing_or_foreign_persona_as_none() {
        let scratch = Scratch::new();
        let personas = Arc::new(
            ChatPersonas::open(&scratch.path("personas.db"), &scratch.dir("personas"))
                .expect("personas"),
        );
        let created = personas
            .run(|repository| {
                repository.create_persona(&betaclaw_core::personas::types::CreatePersonaInput {
                    name: "Ada".into(),
                    emoji: "🤖".into(),
                    vibe: "curious".into(),
                    user_id: "owner-1".into(),
                    ..Default::default()
                })
            })
            .expect("create");
        let port = WsPersonas::new(personas);
        assert!(port
            .find_persona("missing", "owner-1")
            .expect("find")
            .is_none());
        assert!(port
            .find_persona(&created.id, "other-user")
            .expect("find")
            .is_none());
        assert_eq!(
            port.find_persona(&created.id, "owner-1")
                .expect("find")
                .and_then(|record| record.slug),
            Some(created.slug)
        );
    }
}
