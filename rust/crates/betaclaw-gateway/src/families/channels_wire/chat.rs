//! Port of `app/api/channels/messages/route.ts` (POST and DELETE) and
//! `app/api/channels/messages/attachments/route.ts`. The listing (GET) stays in
//! `routes::messages`; the path is shared, and the method routers merge.
//!
//! The POST is the web chat dispatch. It resolves the conversation, binds its
//! persona, stores the attachment and hands the message to the [`ChannelInbound`]
//! port, as `handleWebUIMessage` in `handlers/webUIHandler.ts` does.

use std::collections::HashMap;
use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Extension, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use betaclaw_core::channels::messages::service::inbound::handle_inbound::{
    InboundOptions, InboundParams, InboundResult,
};
use betaclaw_core::gateway::broadcast::broadcast_to_user;
use betaclaw_core::gateway::events::CHAT_MESSAGE_DELETED;
use betaclaw_core::messages_store::types::ChannelType;
use betaclaw_core::messages_store::MessageRepositoryError;
use serde_json::{json, Map, Value};

use super::attachments::{
    extract_from_metadata, metadata_for, AttachmentStore, IncomingAttachment,
};
use super::{parse_body, text_field, Services};
use crate::auth_gate::{unauthorized_response, user_id_from_headers};
use crate::routes::channel_support::{
    emit_inbox_updated, error_response, failure, parse_int_prefix,
};
use crate::state::{AppState, SharedState};

pub fn router() -> Router<SharedState> {
    Router::new()
        .route(
            "/api/channels/messages",
            post(post_message).delete(delete_message),
        )
        .route("/api/channels/messages/attachments", get(get_attachment))
}

/// A refused chat request: the status and the message the route answers with.
struct ChatFailure {
    status: StatusCode,
    message: String,
}

impl ChatFailure {
    fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }

    fn internal(message: impl Into<String>) -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, message)
    }
}

impl From<MessageRepositoryError> for ChatFailure {
    fn from(error: MessageRepositoryError) -> Self {
        Self::internal(error.to_string())
    }
}

/// `POST /api/channels/messages`.
async fn post_message(
    State(state): State<SharedState>,
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let Some(user_id) = user_id_from_headers(&headers) else {
        return unauthorized_response();
    };
    let body = match parse_body(&body) {
        Ok(body) => body,
        Err(message) => return error_response(StatusCode::INTERNAL_SERVER_ERROR, &message),
    };
    match dispatch_web_message(&state, &services, &user_id, &body).await {
        Ok(result) => Json(json!({
            "ok": true,
            "userMessage": result.user_msg,
            "agentMessage": result.agent_msg,
        }))
        .into_response(),
        Err(refused) => error_response(refused.status, &refused.message),
    }
}

async fn dispatch_web_message(
    state: &SharedState,
    services: &Services,
    user_id: &str,
    body: &Map<String, Value>,
) -> Result<InboundResult, ChatFailure> {
    let (conversation_id, conversation) = {
        let store = state.messages.lock().await;
        let id = match text_field(body, "conversationId") {
            Some(id) => id,
            None => store.get_default_webchat_conversation(Some(user_id))?.id,
        };
        let conversation = store.get_conversation(&id, Some(user_id))?;
        (id, conversation)
    };

    let requested_persona = normalize_persona(text_field(body, "personaId"));
    let bound_persona = normalize_persona(
        conversation
            .as_ref()
            .and_then(|conversation| conversation.persona_id.clone()),
    );
    if let (Some(requested), Some(bound)) = (&requested_persona, &bound_persona) {
        if requested != bound {
            return Err(ChatFailure::new(
                StatusCode::CONFLICT,
                "personaId mismatch: conversation is already bound to a different persona.",
            ));
        }
    }
    if let (Some(requested), Some(_), None) = (&requested_persona, &conversation, &bound_persona) {
        state.messages.lock().await.update_persona_id(
            &conversation_id,
            Some(requested.as_str()),
            user_id,
        )?;
    }

    let persona_slug = match requested_persona.or(bound_persona) {
        Some(persona_id) => state
            .personas
            .lock()
            .await
            .get_persona(&persona_id)
            .map_err(|error| ChatFailure::internal(error.to_string()))?
            .map(|persona| persona.slug),
        None => None,
    };

    let content = body
        .get("content")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let attachment = body.get("attachment").filter(|value| value.is_object());
    let attachment_url = attachment
        .and_then(|value| value.get("url"))
        .and_then(Value::as_str)
        .filter(|url| !url.trim().is_empty());
    if content.is_empty() && attachment_url.is_none() {
        return Err(ChatFailure::new(
            StatusCode::BAD_REQUEST,
            "content or attachment is required",
        ));
    }

    let mut attachments = Vec::new();
    if let (Some(url), Some(meta)) = (attachment_url, attachment) {
        let incoming = IncomingAttachment {
            name: text_of(meta, "name").unwrap_or("attachment").to_string(),
            mime_type: text_of(meta, "type").unwrap_or("").to_string(),
            size: meta
                .get("size")
                .and_then(Value::as_f64)
                .filter(|value| value.is_finite())
                .map_or(0, |value| value.max(0.0) as u64),
            data_url: url.to_string(),
        };
        let stored = services
            .attachments
            .persist(
                user_id,
                &conversation_id,
                persona_slug.as_deref(),
                &incoming,
            )
            .map_err(|message| ChatFailure::new(StatusCode::BAD_REQUEST, message))?;
        attachments.push(stored);
    }

    let conversation = conversation
        .ok_or_else(|| ChatFailure::internal("Conversation not found for current user."))?;
    let platform = ChannelType::parse(&conversation.channel_type).ok_or_else(|| {
        ChatFailure::internal(format!(
            "Unknown channel type: {}",
            conversation.channel_type
        ))
    })?;
    let external_chat_id = conversation
        .external_chat_id
        .clone()
        .filter(|id| !id.is_empty())
        .unwrap_or_else(|| "default".to_string());

    let params = InboundParams {
        platform,
        external_chat_id,
        content,
        sender_name: None,
        external_msg_id: None,
        user_id: Some(conversation.user_id.clone()),
        client_message_id: text_field(body, "clientMessageId"),
        attachment_metadata: metadata_for(&attachments),
        on_stream_delta: None,
        opts: InboundOptions::default(),
    };
    services
        .inbound
        .handle_inbound(params)
        .await
        .map_err(|error| ChatFailure::internal(error.to_string()))
}

/// `DELETE /api/channels/messages?messageId=&conversationId=`. Besides the row,
/// the chat is told that the message is gone, the inbox entry is refreshed, and
/// the stored attachment files are removed.
async fn delete_message(
    State(state): State<SharedState>,
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    let Some(user_id) = user_id_from_headers(&headers) else {
        return unauthorized_response();
    };
    let Some(message_id) = query_value(&query, "messageId") else {
        return error_response(StatusCode::BAD_REQUEST, "messageId is required");
    };
    let conversation_filter = query_value(&query, "conversationId");
    match delete_message_with_side_effects(
        &state,
        &services.attachments,
        &user_id,
        message_id,
        conversation_filter,
    )
    .await
    {
        Ok(true) => Json(json!({ "ok": true })).into_response(),
        Ok(false) => error_response(StatusCode::NOT_FOUND, "Message not found"),
        Err(error) => failure(&error),
    }
}

/// The delete of one message of `user_id`, with its side effects: the row, the
/// stored attachment files (best effort), the chat event and the inbox entry.
/// `Ok(false)` when the message does not exist for this user, or is not in
/// `conversation_filter`. Shared by the route and the `/chatdelete` command.
pub(crate) async fn delete_message_with_side_effects(
    state: &AppState,
    attachments: &AttachmentStore,
    user_id: &str,
    message_id: &str,
    conversation_filter: Option<&str>,
) -> Result<bool, MessageRepositoryError> {
    let existing = state
        .messages
        .lock()
        .await
        .get_message(message_id, Some(user_id))?;
    let Some(existing) = existing else {
        return Ok(false);
    };
    if conversation_filter.is_some_and(|filter| filter != existing.conversation_id) {
        return Ok(false);
    }
    let deleted = state
        .messages
        .lock()
        .await
        .delete_message(message_id, user_id)?;
    if !deleted {
        return Ok(false);
    }

    for attachment in extract_from_metadata(existing.metadata.as_deref()) {
        attachments.delete(&attachment);
    }
    broadcast_to_user(
        &state.registry,
        user_id,
        CHAT_MESSAGE_DELETED,
        Some(json!({
            "messageId": message_id,
            "conversationId": existing.conversation_id,
        })),
    );
    let inbox_item = state
        .messages
        .lock()
        .await
        .get_inbox_item(&existing.conversation_id, user_id)?;
    let action = if inbox_item.is_some() {
        "upsert"
    } else {
        "delete"
    };
    emit_inbox_updated(
        state,
        user_id,
        action,
        &existing.conversation_id,
        inbox_item,
    );
    Ok(true)
}

/// `GET /api/channels/messages/attachments?messageId=&conversationId=&index=`.
/// Streams one stored attachment of a message the caller can read.
async fn get_attachment(
    State(state): State<SharedState>,
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    let Some(user_id) = user_id_from_headers(&headers) else {
        return unauthorized_response();
    };
    let Some(message_id) = query_value(&query, "messageId") else {
        return error_response(StatusCode::BAD_REQUEST, "messageId is required");
    };
    let conversation_id = query_value(&query, "conversationId");
    let index = match parse_int_prefix(query_value(&query, "index").unwrap_or("0")) {
        Some(index) if index >= 0 => index as usize,
        _ => {
            return error_response(
                StatusCode::BAD_REQUEST,
                "index must be a non-negative integer",
            )
        }
    };

    let found = state
        .messages
        .lock()
        .await
        .get_message(message_id, Some(user_id.as_str()));
    let message = match found {
        Ok(Some(message)) => message,
        Ok(None) => return error_response(StatusCode::NOT_FOUND, "Message not found"),
        Err(error) => return failure(&error),
    };
    if conversation_id.is_some_and(|filter| filter != message.conversation_id) {
        return error_response(StatusCode::NOT_FOUND, "Message not found");
    }

    let attachments = extract_from_metadata(message.metadata.as_deref());
    let Some(attachment) = attachments.get(index) else {
        return error_response(StatusCode::NOT_FOUND, "Attachment not found");
    };
    let bytes = match services.attachments.read(attachment) {
        Ok(bytes) => bytes,
        Err(_) => return error_response(StatusCode::NOT_FOUND, "Attachment file missing"),
    };

    let content_type = HeaderValue::from_str(&attachment.mime_type)
        .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream"));
    let disposition = HeaderValue::from_str(&format!(
        "inline; filename=\"{}\"",
        attachment.name.replace('"', "")
    ))
    .unwrap_or_else(|_| HeaderValue::from_static("inline"));
    let response_headers = [
        (header::CONTENT_TYPE, content_type),
        (header::CONTENT_LENGTH, HeaderValue::from(bytes.len())),
        (
            header::CACHE_CONTROL,
            HeaderValue::from_static("private, max-age=3600"),
        ),
        (header::CONTENT_DISPOSITION, disposition),
    ];
    (StatusCode::OK, response_headers, bytes).into_response()
}

/// A query value, trimmed. An empty value reads as absent.
fn query_value<'a>(query: &'a HashMap<String, String>, key: &str) -> Option<&'a str> {
    query
        .get(key)
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
}

/// `normalizePersonaId`: trimmed, and an empty value is absent.
fn normalize_persona(value: Option<String>) -> Option<String> {
    value
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())
}

fn text_of<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
}

#[cfg(test)]
mod tests {
    use axum::http::Method;
    use betaclaw_core::messages_store::{MessageRole, SaveMessageInput};

    use super::*;
    use crate::families::channels_wire::attachments::StoredAttachment;
    use crate::families::channels_wire::test_support::{
        assert_keys, harness, harness_with, FakeInbound, ScratchDir, USER,
    };

    const PATH: &str = "/api/channels/messages";

    #[tokio::test]
    async fn posting_needs_a_user() {
        let scratch = ScratchDir::new();
        let h = harness(&scratch);

        let (status, body) = h
            .send(Method::POST, PATH, None, Some("{\"content\":\"hi\"}"))
            .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_keys(&body, &["error", "ok"]);
    }

    #[tokio::test]
    async fn an_empty_message_without_attachment_is_refused() {
        let scratch = ScratchDir::new();
        let h = harness(&scratch);

        let (status, body) = h
            .send(
                Method::POST,
                PATH,
                Some(USER),
                Some("{\"content\":\"   \"}"),
            )
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "content or attachment is required");
        assert!(h.inbound.calls.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_message_is_dispatched_into_its_conversation() {
        let scratch = ScratchDir::new();
        let h = harness(&scratch);
        let conversation = h
            .state
            .messages
            .lock()
            .await
            .get_or_create_conversation("WebChat", "web-1", Some("Web"), Some(USER))
            .expect("conversation");
        let payload = format!(
            "{{\"conversationId\":\"{}\",\"content\":\"  hallo  \",\"clientMessageId\":\"c1\"}}",
            conversation.id
        );

        let (status, body) = h.send(Method::POST, PATH, Some(USER), Some(&payload)).await;

        assert_eq!(status, StatusCode::OK);
        assert_keys(&body, &["agentMessage", "ok", "userMessage"]);
        assert_eq!(body["userMessage"]["id"], "u-1");
        assert_eq!(body["agentMessage"]["content"], "reply");
        let calls = h.inbound.calls.lock().unwrap().clone();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].platform, ChannelType::WebChat);
        assert_eq!(calls[0].external_chat_id, "web-1");
        assert_eq!(calls[0].content, "hallo");
        assert_eq!(calls[0].user_id.as_deref(), Some(USER));
        assert_eq!(calls[0].client_message_id.as_deref(), Some("c1"));
    }

    #[tokio::test]
    async fn a_conversation_bound_to_another_persona_is_a_conflict() {
        let scratch = ScratchDir::new();
        let h = harness(&scratch);
        let conversation = h
            .state
            .messages
            .lock()
            .await
            .get_or_create_conversation("WebChat", "web-2", None, Some(USER))
            .expect("conversation");
        h.state
            .messages
            .lock()
            .await
            .update_persona_id(&conversation.id, Some("p1"), USER)
            .expect("bind persona");
        let payload = format!(
            "{{\"conversationId\":\"{}\",\"content\":\"hi\",\"personaId\":\"p2\"}}",
            conversation.id
        );

        let (status, body) = h.send(Method::POST, PATH, Some(USER), Some(&payload)).await;

        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(
            body["error"],
            "personaId mismatch: conversation is already bound to a different persona."
        );
        assert!(h.inbound.calls.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn an_attachment_is_stored_and_its_metadata_reaches_the_dispatch() {
        let scratch = ScratchDir::new();
        let h = harness(&scratch);
        let payload = "{\"attachment\":{\"name\":\"a.txt\",\"type\":\"text/plain\",\"size\":2,\"url\":\"data:text/plain;base64,aGk=\"}}";

        let (status, _) = h.send(Method::POST, PATH, Some(USER), Some(payload)).await;

        assert_eq!(status, StatusCode::OK);
        let calls = h.inbound.calls.lock().unwrap().clone();
        let metadata = calls[0].attachment_metadata.clone().expect("metadata");
        assert_eq!(metadata["attachments"][0]["name"], "a.txt");
        assert_eq!(metadata["attachments"][0]["size"], 2);
    }

    #[tokio::test]
    async fn a_refused_attachment_is_a_bad_request_with_the_reason() {
        let scratch = ScratchDir::new();
        let h = harness(&scratch);
        let payload = "{\"attachment\":{\"name\":\"a.exe\",\"type\":\"application/x-msdownload\",\"size\":2,\"url\":\"data:application/x-msdownload;base64,aGk=\"}}";

        let (status, body) = h.send(Method::POST, PATH, Some(USER), Some(payload)).await;

        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(
            body["error"],
            "Attachment MIME type is not allowed: application/x-msdownload"
        );
    }

    #[tokio::test]
    async fn a_failed_dispatch_is_a_server_error() {
        let scratch = ScratchDir::new();
        let h = harness_with(
            &scratch,
            FakeInbound {
                fail: true,
                ..FakeInbound::default()
            },
        );

        let (status, body) = h
            .send(Method::POST, PATH, Some(USER), Some("{\"content\":\"hi\"}"))
            .await;

        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(body["error"], "dispatch refused");
    }

    #[tokio::test]
    async fn deleting_needs_a_message_id_and_an_existing_message() {
        let scratch = ScratchDir::new();
        let h = harness(&scratch);

        let (status, body) = h.send(Method::DELETE, PATH, Some(USER), None).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "messageId is required");

        let (status, body) = h
            .send(
                Method::DELETE,
                &format!("{PATH}?messageId=nope"),
                Some(USER),
                None,
            )
            .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["error"], "Message not found");
    }

    #[tokio::test]
    async fn deleting_a_message_removes_it() {
        let scratch = ScratchDir::new();
        let h = harness(&scratch);
        let conversation = h
            .state
            .messages
            .lock()
            .await
            .get_or_create_conversation("WebChat", "web-3", None, Some(USER))
            .expect("conversation");
        let saved = h
            .state
            .messages
            .lock()
            .await
            .save_message(&SaveMessageInput {
                conversation_id: &conversation.id,
                role: MessageRole::User,
                content: "bye",
                platform: "WebChat",
                external_msg_id: None,
                sender_name: None,
                metadata: None,
                client_message_id: None,
            })
            .expect("save message");

        let (status, body) = h
            .send(
                Method::DELETE,
                &format!("{PATH}?messageId={}", saved.id),
                Some(USER),
                None,
            )
            .await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, json!({"ok": true}));
        let remaining = h
            .state
            .messages
            .lock()
            .await
            .get_message(&saved.id, Some(USER))
            .expect("lookup");
        assert!(remaining.is_none());
    }

    #[tokio::test]
    async fn an_attachment_streams_with_its_type_and_name() {
        let scratch = ScratchDir::new();
        let h = harness(&scratch);
        let stored: StoredAttachment = h
            .services
            .attachments
            .persist(
                USER,
                "conv-x",
                None,
                &IncomingAttachment {
                    name: "a.txt".to_string(),
                    mime_type: "text/plain".to_string(),
                    size: 2,
                    data_url: "data:text/plain;base64,aGk=".to_string(),
                },
            )
            .expect("stored");
        let metadata = metadata_for(std::slice::from_ref(&stored));
        let conversation = h
            .state
            .messages
            .lock()
            .await
            .get_or_create_conversation("WebChat", "web-4", None, Some(USER))
            .expect("conversation");
        let saved = h
            .state
            .messages
            .lock()
            .await
            .save_message(&SaveMessageInput {
                conversation_id: &conversation.id,
                role: MessageRole::User,
                content: "file",
                platform: "WebChat",
                external_msg_id: None,
                sender_name: None,
                metadata: metadata.as_ref(),
                client_message_id: None,
            })
            .expect("save message");
        let base = "/api/channels/messages/attachments";

        let uri = format!("{base}?messageId={}&index=0", saved.id);
        let (status, headers, bytes) = h
            .raw(Method::GET, &uri, &[("x-betaclaw-user-id", USER)], None)
            .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(&bytes[..], b"hi");
        assert_eq!(headers[header::CONTENT_TYPE], "text/plain");
        assert_eq!(
            headers[header::CONTENT_DISPOSITION],
            "inline; filename=\"a.txt\""
        );

        let uri = format!("{base}?messageId={}&index=1", saved.id);
        let (status, body) = h.send(Method::GET, &uri, Some(USER), None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["error"], "Attachment not found");

        let uri = format!("{base}?messageId={}&index=-1", saved.id);
        let (status, body) = h.send(Method::GET, &uri, Some(USER), None).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "index must be a non-negative integer");

        let (status, _) = h.send(Method::GET, &uri, None, None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }
}
