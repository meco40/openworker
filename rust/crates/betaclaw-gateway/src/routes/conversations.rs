//! Conversation routes.
//!
//! Port of `app/api/channels/conversations/route.ts`. `GET` lists the user's
//! conversations and makes sure the default WebChat conversation exists. `POST`
//! creates one, `DELETE ?id=` removes one, and `PATCH` sets the model override or
//! the persona. Errors keep the `{ ok: false, error }` shape. Other methods are
//! proxied to Next.js.
//!
//! `DELETE` removes the conversation and every derived row the shared messages
//! database owns. The TypeScript side additionally aborts an in-flight
//! generation (`abortGeneration`) and clears the per-conversation summary and
//! recall state (`summaryService.clearInFlight`,
//! `recallService.clearConversationState`, `maintenance/operations.ts:41-51`).
//! That state belongs to the Node process that runs the generation loop; the
//! gateway has no dispatch loop yet, so nothing in Rust holds it. This is the
//! honest remainder of OP-1 until S8.
//!
//! `logChatDisplayTrace` for the `GET` path is ported in `channel_support`
//! (`http.conversations.complete`), so OP-2 is closed for this route.

use std::collections::HashMap;

use axum::body::Bytes;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use betaclaw_core::gateway::broadcast::broadcast_to_user;
use betaclaw_core::gateway::events::CONVERSATION_DELETED;
use betaclaw_core::messages_store::InboxItemRecord;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::auth_gate::{unauthorized_response, user_id_from_headers};
use crate::proxy::proxy_to_upstream;
use crate::routes::channel_support::{
    emit_inbox_updated, error_response, failure, get_chat_display_slow_threshold_ms,
    log_chat_display_trace,
};
use crate::state::SharedState;

/// `listConversations(limit = 50)` default in `repository/queries/conversations.ts`.
const LIST_LIMIT: i64 = 50;

pub fn router() -> Router<SharedState> {
    Router::new().route(
        "/api/channels/conversations",
        get(list_conversations)
            .post(create_conversation)
            .delete(delete_conversation)
            .patch(update_conversation)
            .fallback(proxy_to_upstream),
    )
}

/// `GET /api/channels/conversations`
async fn list_conversations(State(state): State<SharedState>, headers: HeaderMap) -> Response {
    let Some(user_id) = user_id_from_headers(&headers) else {
        return unauthorized_response();
    };
    let started = std::time::Instant::now();
    let store = state.messages.lock().await;
    // Ensures the default WebChat conversation exists, so the input is never disabled.
    if let Err(error) = store.get_default_webchat_conversation(Some(user_id.as_str())) {
        return failure(&error);
    }
    match store.list_conversations(LIST_LIMIT, Some(user_id.as_str())) {
        Ok(conversations) => {
            let duration_ms = started.elapsed().as_millis() as u64;
            log_chat_display_trace(
                "http.conversations.complete",
                &json!({
                    "path": "/api/channels/conversations",
                    "userId": user_id,
                    "returned": conversations.len(),
                    "durationMs": duration_ms,
                }),
                duration_ms >= get_chat_display_slow_threshold_ms(),
            );
            Json(json!({ "ok": true, "conversations": conversations })).into_response()
        }
        Err(error) => failure(&error),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateBody {
    channel_type: Option<String>,
    title: Option<String>,
    persona_id: Option<String>,
}

/// `POST /api/channels/conversations`
async fn create_conversation(
    State(state): State<SharedState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let Some(user_id) = user_id_from_headers(&headers) else {
        return unauthorized_response();
    };
    let body: CreateBody = match serde_json::from_slice(&body) {
        Ok(body) => body,
        Err(error) => {
            return error_response(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string());
        }
    };
    let Some(channel_type) = body.channel_type.filter(|value| !value.is_empty()) else {
        return error_response(StatusCode::BAD_REQUEST, "channelType is required");
    };
    let external_chat_id = format!("manual-{user_id}-{}", chrono::Utc::now().timestamp_millis());

    let conversation = {
        let store = state.messages.lock().await;
        let created = store.get_or_create_conversation(
            &channel_type,
            &external_chat_id,
            body.title.as_deref(),
            Some(user_id.as_str()),
        );
        let mut conversation = match created {
            Ok(conversation) => conversation,
            Err(error) => return failure(&error),
        };
        if let Some(persona_id) = body.persona_id.filter(|value| !value.is_empty()) {
            if let Err(error) =
                store.update_persona_id(&conversation.id, Some(persona_id.as_str()), &user_id)
            {
                return failure(&error);
            }
            conversation.persona_id = Some(persona_id);
        }
        conversation
    };

    emit_inbox_updated(
        &state,
        &user_id,
        "upsert",
        &conversation.id,
        Some(InboxItemRecord {
            conversation_id: conversation.id.clone(),
            channel_type: conversation.channel_type.clone(),
            title: conversation.title.clone(),
            updated_at: conversation.updated_at.clone(),
            last_message: None,
        }),
    );
    Json(json!({ "ok": true, "conversation": conversation })).into_response()
}

/// `DELETE /api/channels/conversations?id=<conversationId>`
async fn delete_conversation(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let Some(user_id) = user_id_from_headers(&headers) else {
        return unauthorized_response();
    };
    let Some(conversation_id) = params.get("id").filter(|value| !value.is_empty()) else {
        return error_response(StatusCode::BAD_REQUEST, "id query param is required");
    };

    let deleted = state
        .messages
        .lock()
        .await
        .delete_conversation(conversation_id.as_str(), user_id.as_str());
    match deleted {
        Ok(true) => {}
        Ok(false) => return error_response(StatusCode::NOT_FOUND, "Conversation not found"),
        Err(error) => return failure(&error),
    }

    broadcast_to_user(
        &state.registry,
        &user_id,
        CONVERSATION_DELETED,
        Some(json!({ "conversationId": conversation_id })),
    );
    emit_inbox_updated(&state, &user_id, "delete", conversation_id, None);
    Json(json!({ "ok": true })).into_response()
}

/// `PATCH /api/channels/conversations`
///
/// Body: `{ conversationId, modelOverride?: string | null, personaId?: string | null }`.
/// Keys that are present are applied, even when their value is null.
async fn update_conversation(
    State(state): State<SharedState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let Some(user_id) = user_id_from_headers(&headers) else {
        return unauthorized_response();
    };
    let body: Value = match serde_json::from_slice(&body) {
        Ok(body) => body,
        Err(error) => {
            return error_response(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string());
        }
    };
    let fields = body.as_object();
    let conversation_id = fields
        .and_then(|fields| fields.get("conversationId"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty());
    let Some(conversation_id) = conversation_id else {
        return error_response(StatusCode::BAD_REQUEST, "conversationId is required");
    };

    let store = state.messages.lock().await;

    if let Some(value) = fields.and_then(|fields| fields.get("modelOverride")) {
        let model_override = match value {
            Value::Null => None,
            Value::String(text) => Some(text.clone()),
            Value::Number(number) => Some(number.to_string()),
            // better-sqlite3 refuses to bind booleans, arrays and objects.
            _ => {
                return error_response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "SQLite3 can only bind numbers, strings, bigints, buffers, and null",
                );
            }
        };
        if let Err(error) = store.update_model_override(
            conversation_id,
            model_override.as_deref(),
            user_id.as_str(),
        ) {
            return failure(&error);
        }
    }

    if fields.is_some_and(|fields| fields.contains_key("personaId")) {
        let requested = normalize_persona_id(
            fields
                .and_then(|fields| fields.get("personaId"))
                .and_then(Value::as_str),
        );
        let current = match store.get_conversation(conversation_id, Some(user_id.as_str())) {
            Ok(conversation) => normalize_persona_id(
                conversation
                    .as_ref()
                    .and_then(|conversation| conversation.persona_id.as_deref()),
            ),
            Err(error) => return failure(&error),
        };
        if let Some(current) = current {
            if requested.as_deref() != Some(current.as_str()) {
                return error_response(
                    StatusCode::CONFLICT,
                    "personaId mismatch: conversation is already bound to a different persona.",
                );
            }
        }
        if let Err(error) =
            store.update_persona_id(conversation_id, requested.as_deref(), user_id.as_str())
        {
            return failure(&error);
        }
    }

    Json(json!({ "ok": true })).into_response()
}

/// Port of `normalizePersonaId`: trimmed, and an empty value counts as absent.
fn normalize_persona_id(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::routes::test_support::{assert_keys, send, state_in, ScratchDir};
    use crate::state::AppState;
    use axum::http::Method;
    use betaclaw_core::gateway::client::{ClientHandle, Outbound};
    use std::sync::Arc;
    use tokio::sync::mpsc;

    const USER: &str = "user-conversations";

    /// Registers one open connection for `USER` and returns its outbound queue.
    fn connect(state: &Arc<AppState>) -> mpsc::Receiver<Outbound> {
        let (tx, rx) = mpsc::channel(64);
        state
            .registry
            .register(ClientHandle::new("conn-1", USER, "v2", 0, tx));
        rx
    }

    /// Event names of every frame received so far, in arrival order.
    fn received_events(rx: &mut mpsc::Receiver<Outbound>) -> Vec<String> {
        let mut events = Vec::new();
        while let Ok(Outbound::Text(text)) = rx.try_recv() {
            let frame: Value = serde_json::from_str(&text).expect("json frame");
            events.push(frame["event"].as_str().unwrap_or_default().to_string());
        }
        events
    }

    async fn create(state: &Arc<AppState>, body: &str) -> Value {
        let (status, created) = send(
            state,
            Method::POST,
            "/api/channels/conversations",
            Some(USER),
            Some(body),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        created
    }

    #[tokio::test]
    async fn get_creates_the_default_conversation_and_lists_it() {
        let scratch = ScratchDir::new();
        let state = state_in(&scratch);

        let (status, body) = send(
            &state,
            Method::GET,
            "/api/channels/conversations",
            Some(USER),
            None,
        )
        .await;

        assert_eq!(status, StatusCode::OK);
        assert_keys(&body, &["conversations", "ok"]);
        let conversations = body["conversations"].as_array().expect("array");
        assert_eq!(conversations.len(), 1);
        assert_eq!(conversations[0]["channelType"], "WebChat");
    }

    #[tokio::test]
    async fn get_without_user_is_unauthorized() {
        let scratch = ScratchDir::new();
        let state = state_in(&scratch);

        let (status, body) = send(
            &state,
            Method::GET,
            "/api/channels/conversations",
            None,
            None,
        )
        .await;

        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_keys(&body, &["error", "ok"]);
    }

    #[tokio::test]
    async fn post_requires_a_channel_type() {
        let scratch = ScratchDir::new();
        let state = state_in(&scratch);

        let (status, body) = send(
            &state,
            Method::POST,
            "/api/channels/conversations",
            Some(USER),
            Some("{}"),
        )
        .await;

        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_keys(&body, &["error", "ok"]);
        assert_eq!(body["error"], "channelType is required");
    }

    #[tokio::test]
    async fn post_creates_a_persona_bound_conversation_and_announces_it() {
        let scratch = ScratchDir::new();
        let state = state_in(&scratch);
        let mut rx = connect(&state);

        let created = create(
            &state,
            r#"{"channelType":"WebChat","title":"Plan","personaId":"persona-1"}"#,
        )
        .await;

        assert_keys(&created, &["conversation", "ok"]);
        assert_eq!(created["conversation"]["title"], "Plan");
        assert_eq!(created["conversation"]["personaId"], "persona-1");
        assert_eq!(received_events(&mut rx), vec!["inbox.updated"]);
    }

    #[tokio::test]
    async fn delete_requires_an_id() {
        let scratch = ScratchDir::new();
        let state = state_in(&scratch);

        let (status, body) = send(
            &state,
            Method::DELETE,
            "/api/channels/conversations",
            Some(USER),
            None,
        )
        .await;

        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "id query param is required");
    }

    #[tokio::test]
    async fn delete_of_an_unknown_conversation_is_not_found() {
        let scratch = ScratchDir::new();
        let state = state_in(&scratch);

        let (status, body) = send(
            &state,
            Method::DELETE,
            "/api/channels/conversations?id=missing",
            Some(USER),
            None,
        )
        .await;

        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_keys(&body, &["error", "ok"]);
        assert_eq!(body["error"], "Conversation not found");
    }

    #[tokio::test]
    async fn delete_removes_the_conversation_and_broadcasts_both_events() {
        let scratch = ScratchDir::new();
        let state = state_in(&scratch);
        let created = create(&state, r#"{"channelType":"WebChat"}"#).await;
        let id = created["conversation"]["id"]
            .as_str()
            .expect("id")
            .to_string();
        let mut rx = connect(&state);

        let uri = format!("/api/channels/conversations?id={id}");
        let (status, body) = send(&state, Method::DELETE, &uri, Some(USER), None).await;

        assert_eq!(status, StatusCode::OK);
        assert_keys(&body, &["ok"]);
        assert_eq!(
            received_events(&mut rx),
            vec!["conversation.deleted", "inbox.updated"]
        );
        let (again, _) = send(&state, Method::DELETE, &uri, Some(USER), None).await;
        assert_eq!(again, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn patch_requires_a_conversation_id() {
        let scratch = ScratchDir::new();
        let state = state_in(&scratch);

        let (status, body) = send(
            &state,
            Method::PATCH,
            "/api/channels/conversations",
            Some(USER),
            Some("{}"),
        )
        .await;

        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "conversationId is required");
    }

    #[tokio::test]
    async fn patch_sets_the_model_override() {
        let scratch = ScratchDir::new();
        let state = state_in(&scratch);
        let created = create(&state, r#"{"channelType":"WebChat"}"#).await;
        let id = created["conversation"]["id"]
            .as_str()
            .expect("id")
            .to_string();

        let payload = json!({ "conversationId": id, "modelOverride": "model-x" });
        let (status, body) = send(
            &state,
            Method::PATCH,
            "/api/channels/conversations",
            Some(USER),
            Some(&payload.to_string()),
        )
        .await;

        assert_eq!(status, StatusCode::OK);
        assert_keys(&body, &["ok"]);
        let stored = state
            .messages
            .lock()
            .await
            .get_conversation(&id, Some(USER))
            .expect("query")
            .expect("conversation exists");
        assert_eq!(stored.model_override.as_deref(), Some("model-x"));
    }

    #[tokio::test]
    async fn patch_refuses_to_rebind_a_conversation_to_another_persona() {
        let scratch = ScratchDir::new();
        let state = state_in(&scratch);
        let created = create(
            &state,
            r#"{"channelType":"WebChat","personaId":"persona-1"}"#,
        )
        .await;
        let id = created["conversation"]["id"]
            .as_str()
            .expect("id")
            .to_string();

        let payload = json!({ "conversationId": id, "personaId": "persona-2" });
        let (status, body) = send(
            &state,
            Method::PATCH,
            "/api/channels/conversations",
            Some(USER),
            Some(&payload.to_string()),
        )
        .await;

        assert_eq!(status, StatusCode::CONFLICT);
        assert_keys(&body, &["error", "ok"]);
        assert_eq!(
            body["error"],
            "personaId mismatch: conversation is already bound to a different persona."
        );
    }

    #[tokio::test]
    async fn unported_methods_fall_through_to_the_proxy() {
        let scratch = ScratchDir::new();
        let state = state_in(&scratch);

        let (status, _) = send(
            &state,
            Method::PUT,
            "/api/channels/conversations",
            Some(USER),
            Some("{}"),
        )
        .await;

        assert_eq!(status, StatusCode::BAD_GATEWAY);
    }
}
