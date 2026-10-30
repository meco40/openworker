//! Message listing route.
//!
//! Port of the `GET` half of `app/api/channels/messages/route.ts`. Without a
//! `conversationId` it answers for the default WebChat conversation. `POST` is
//! the chat dispatch and stays on the TypeScript side, so it is proxied.

use std::collections::HashMap;

use axum::extract::{Query, State};
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde_json::json;

use crate::auth_gate::{unauthorized_response, user_id_from_headers};
use crate::proxy::proxy_to_upstream;
use crate::routes::channel_support::{
    failure, get_chat_display_slow_threshold_ms, log_chat_display_trace, parse_int_prefix,
};
use crate::state::SharedState;

/// The TypeScript route reads 100 messages when no `limit` is given.
const DEFAULT_LIMIT: i64 = 100;

pub fn router() -> Router<SharedState> {
    Router::new().route(
        "/api/channels/messages",
        get(list_messages).fallback(proxy_to_upstream),
    )
}

/// `GET /api/channels/messages?conversationId=&limit=&before=`
async fn list_messages(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let Some(user_id) = user_id_from_headers(&headers) else {
        return unauthorized_response();
    };
    // `parseInt(searchParams.get('limit') || '100')`. A value that is not a
    // number falls back to the default here; TypeScript passes NaN through.
    let limit = params
        .get("limit")
        .filter(|value| !value.is_empty())
        .and_then(|value| parse_int_prefix(value.as_str()))
        .unwrap_or(DEFAULT_LIMIT);
    let before = params.get("before").filter(|value| !value.is_empty());
    let requested = params
        .get("conversationId")
        .filter(|value| !value.is_empty());

    let started = std::time::Instant::now();
    let store = state.messages.lock().await;
    let conversation_id = match requested {
        Some(id) => id.clone(),
        None => match store.get_default_webchat_conversation(Some(user_id.as_str())) {
            Ok(conversation) => conversation.id,
            Err(error) => return failure(&error),
        },
    };
    match store.list_messages(
        conversation_id.as_str(),
        limit,
        before.map(String::as_str),
        Some(user_id.as_str()),
    ) {
        Ok(messages) => {
            let duration_ms = started.elapsed().as_millis() as u64;
            log_chat_display_trace(
                "http.messages.complete",
                &json!({
                    "path": "/api/channels/messages",
                    "userId": user_id,
                    "conversationId": conversation_id,
                    "requestedDefaultConversation": requested.is_none(),
                    "limit": limit,
                    "hasBefore": before.is_some(),
                    "returned": messages.len(),
                    "durationMs": duration_ms,
                }),
                duration_ms >= get_chat_display_slow_threshold_ms(),
            );
            Json(json!({
                "ok": true,
                "conversationId": conversation_id,
                "messages": messages,
            }))
            .into_response()
        }
        Err(error) => failure(&error),
    }
}

#[cfg(test)]
mod tests {
    use crate::routes::test_support::{assert_keys, send, state_in, ScratchDir};
    use crate::state::SharedState;
    use axum::http::{Method, StatusCode};
    use betaclaw_core::messages_store::{MessageRole, SaveMessageInput};

    const USER: &str = "user-messages";

    async fn save(state: &SharedState, conversation_id: &str, content: &str) {
        state
            .messages
            .lock()
            .await
            .save_message(&SaveMessageInput {
                conversation_id,
                role: MessageRole::User,
                content,
                platform: "WebChat",
                external_msg_id: None,
                sender_name: None,
                metadata: None,
                client_message_id: None,
            })
            .expect("save message");
    }

    #[tokio::test]
    async fn without_a_conversation_id_it_lists_the_default_conversation() {
        let scratch = ScratchDir::new();
        let state = state_in(&scratch);
        let default_id = state
            .messages
            .lock()
            .await
            .get_default_webchat_conversation(Some(USER))
            .expect("default conversation")
            .id;
        save(&state, &default_id, "hello").await;

        let (status, body) = send(
            &state,
            Method::GET,
            "/api/channels/messages",
            Some(USER),
            None,
        )
        .await;

        assert_eq!(status, StatusCode::OK);
        assert_keys(&body, &["conversationId", "messages", "ok"]);
        assert_eq!(body["conversationId"], default_id.as_str());
        let messages = body["messages"].as_array().expect("array");
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0]["content"], "hello");
    }

    #[tokio::test]
    async fn lists_one_conversation_and_honours_the_limit() {
        let scratch = ScratchDir::new();
        let state = state_in(&scratch);
        let id = state
            .messages
            .lock()
            .await
            .get_or_create_conversation("WebChat", "chat-x", Some("Notes"), Some(USER))
            .expect("conversation")
            .id;
        for content in ["one", "two", "three"] {
            save(&state, &id, content).await;
        }

        let uri = format!("/api/channels/messages?conversationId={id}&limit=2");
        let (status, body) = send(&state, Method::GET, &uri, Some(USER), None).await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["conversationId"], id.as_str());
        assert_eq!(body["messages"].as_array().expect("array").len(), 2);
    }

    #[tokio::test]
    async fn another_user_sees_no_messages_of_this_conversation() {
        let scratch = ScratchDir::new();
        let state = state_in(&scratch);
        let id = state
            .messages
            .lock()
            .await
            .get_or_create_conversation("WebChat", "chat-y", Some("Private"), Some(USER))
            .expect("conversation")
            .id;
        save(&state, &id, "secret").await;

        let uri = format!("/api/channels/messages?conversationId={id}");
        let (status, body) = send(&state, Method::GET, &uri, Some("someone-else"), None).await;

        assert_eq!(status, StatusCode::OK);
        assert!(body["messages"].as_array().expect("array").is_empty());
    }

    #[tokio::test]
    async fn without_a_user_the_listing_is_unauthorized() {
        let scratch = ScratchDir::new();
        let state = state_in(&scratch);

        let (status, body) = send(&state, Method::GET, "/api/channels/messages", None, None).await;

        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_keys(&body, &["error", "ok"]);
    }
}
