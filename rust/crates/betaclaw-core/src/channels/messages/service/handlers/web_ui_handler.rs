//! Port of `src/server/channels/messages/service/handlers/webUIHandler.ts`.
//!
//! `handle_web_ui_message` resolves the web chat conversation and forwards the
//! message to the inbound pipeline with that conversation's channel, external id
//! and user. The inbound pipeline itself (`handleInbound`) is a port here.

use std::sync::Arc;

use serde_json::Value;

use crate::channels::messages::service::conversation::ports::SessionPort;
use crate::channels::messages::service::execution::ports::{PortError, PortResult, StreamSink};
use crate::channels::messages::service::inbound::handle_inbound::InboundOptions;
use crate::channels::messages::service::subagent::utils::non_empty;
use crate::messages_store::types::{ChannelType, StoredMessage};
use crate::model_hub::http::BoxFuture;

/// `handleInbound` of the service. Only the call shape that this handler uses
/// is kept: `senderName` and `externalMsgId` are always `undefined` here.
pub trait InboundPort: Send + Sync {
    fn handle_inbound<'a>(
        &'a self,
        request: InboundRequest,
    ) -> BoxFuture<'a, PortResult<WebUiMessageResult>>;
}

/// Arguments of `handleInbound`. `attachments` are `StoredMessageAttachment` values
/// from `channels/messages/attachments`, passed through as JSON. That module is not
/// ported in S8.
pub struct InboundRequest {
    pub platform: ChannelType,
    pub external_chat_id: String,
    pub content: String,
    pub user_id: String,
    pub client_message_id: Option<String>,
    pub attachments: Option<Vec<Value>>,
    pub on_stream_delta: Option<StreamSink>,
    pub opts: Option<InboundOptions>,
}

/// `WebUIHandlerDeps`. The TS `repo` is captured by the session adapter.
pub struct WebUiHandlerDeps {
    pub session: Arc<dyn SessionPort>,
    pub inbound: Arc<dyn InboundPort>,
}

/// `params` of `handleWebUIMessage`.
pub struct WebUiMessageParams {
    pub conversation_id: String,
    pub content: String,
    pub user_id: Option<String>,
    pub client_message_id: Option<String>,
    pub attachments: Option<Vec<Value>>,
    pub on_stream_delta: Option<StreamSink>,
    pub opts: Option<InboundOptions>,
}

/// `WebUIMessageResult`.
#[derive(Debug, Clone, PartialEq)]
pub struct WebUiMessageResult {
    pub user_msg: StoredMessage,
    pub agent_msg: StoredMessage,
    pub new_conversation_id: Option<String>,
}

/// `handleWebUIMessage(deps, handleInbound, params)`.
pub async fn handle_web_ui_message(
    deps: &WebUiHandlerDeps,
    params: WebUiMessageParams,
) -> PortResult<WebUiMessageResult> {
    let conversation = deps.session.resolve_conversation_for_web_chat(
        &params.conversation_id,
        params.user_id.as_deref().unwrap_or(""),
    )?;

    let platform = ChannelType::parse(&conversation.channel_type).ok_or_else(|| {
        PortError::Failed(format!(
            "Unknown channel type: {}",
            conversation.channel_type
        ))
    })?;
    let external_chat_id = non_empty(conversation.external_chat_id.as_deref())
        .unwrap_or("default")
        .to_string();

    deps.inbound
        .handle_inbound(InboundRequest {
            platform,
            external_chat_id,
            content: params.content,
            user_id: conversation.user_id.clone(),
            client_message_id: params.client_message_id,
            attachments: params.attachments,
            on_stream_delta: params.on_stream_delta,
            opts: params.opts,
        })
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::channels::messages::service::execution::test_doubles::{
        conversation, FakeInbound, FakeSession,
    };

    fn params(conversation_id: &str) -> WebUiMessageParams {
        WebUiMessageParams {
            conversation_id: conversation_id.to_string(),
            content: "hallo".to_string(),
            user_id: Some("user-1".to_string()),
            client_message_id: Some("client-1".to_string()),
            attachments: None,
            on_stream_delta: None,
            opts: Some(InboundOptions {
                require_tool_call: true,
                ..Default::default()
            }),
        }
    }

    fn deps(session: FakeSession, inbound: Arc<FakeInbound>) -> WebUiHandlerDeps {
        WebUiHandlerDeps {
            session: Arc::new(session),
            inbound,
        }
    }

    #[tokio::test]
    async fn forwards_the_resolved_conversation_to_inbound() {
        let inbound = Arc::new(FakeInbound::default());
        let conv = conversation("conv-1", "user-1", None);
        let result = handle_web_ui_message(
            &deps(
                FakeSession {
                    conversation: Some(conv),
                },
                inbound.clone(),
            ),
            params("conv-1"),
        )
        .await
        .unwrap();

        assert_eq!(result.agent_msg.content, "reply");
        let requests = inbound.requests.lock().unwrap();
        assert_eq!(requests[0].platform, ChannelType::WebChat);
        assert_eq!(requests[0].external_chat_id, "web-1");
        assert_eq!(requests[0].user_id, "user-1");
        assert_eq!(requests[0].client_message_id.as_deref(), Some("client-1"));
        assert!(requests[0].opts.as_ref().unwrap().require_tool_call);
    }

    #[tokio::test]
    async fn blank_external_chat_id_falls_back_to_default() {
        let inbound = Arc::new(FakeInbound::default());
        let mut conv = conversation("conv-1", "user-1", None);
        conv.external_chat_id = None;
        handle_web_ui_message(
            &deps(
                FakeSession {
                    conversation: Some(conv),
                },
                inbound.clone(),
            ),
            params("conv-1"),
        )
        .await
        .unwrap();
        assert_eq!(
            inbound.requests.lock().unwrap()[0].external_chat_id,
            "default"
        );
    }

    #[tokio::test]
    async fn unknown_conversation_is_an_error() {
        let inbound = Arc::new(FakeInbound::default());
        let result = handle_web_ui_message(
            &deps(FakeSession { conversation: None }, inbound.clone()),
            params("missing"),
        )
        .await;
        assert_eq!(
            result.unwrap_err(),
            PortError::Failed("Conversation not found for current user.".to_string())
        );
        assert!(inbound.requests.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn unknown_channel_type_is_an_error() {
        let inbound = Arc::new(FakeInbound::default());
        let mut conv = conversation("conv-1", "user-1", None);
        conv.channel_type = "Carrier".to_string();
        let result = handle_web_ui_message(
            &deps(
                FakeSession {
                    conversation: Some(conv),
                },
                inbound.clone(),
            ),
            params("conv-1"),
        )
        .await;
        assert!(matches!(result, Err(PortError::Failed(_))));
        assert!(inbound.requests.lock().unwrap().is_empty());
    }
}
