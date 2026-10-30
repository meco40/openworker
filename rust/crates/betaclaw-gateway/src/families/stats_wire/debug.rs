//! Ports `app/api/debug/conversations/route.ts` (GET),
//! `app/api/debug/conversations/[id]/replay/route.ts` (POST) and
//! `app/api/debug/conversations/[id]/turns/route.ts` (GET).
//!
//! The replay is `src/server/debug/replayService.ts`, ported as
//! `betaclaw_core::debug::replay_service`. The turns join the dispatch rows of the
//! stats store with the messages of the messages store in the application, as the
//! TypeScript does, because the two databases are separate.

use std::collections::HashMap;
use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Extension, Path, RawQuery, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use betaclaw_core::debug::replay_service::{ReplayError, ReplayService};
use betaclaw_core::messages_store::StoredMessage;
use betaclaw_core::stats::prompt_dispatch::PromptDispatchFilter;
use betaclaw_core::stats::util::js_number;
use serde_json::{json, Value};

use super::auth::Caller;
use super::params::{positive_int_or, query_value};
use super::{error_response, Services};
use crate::auth_gate::unauthorized_response;
use crate::proxy::proxy_to_upstream;
use crate::state::SharedState;

/// The previews are cut to this many UTF-16 code units, like `slice(0, 200)`.
const PREVIEW_UNITS: usize = 200;

pub fn router() -> Router<SharedState> {
    Router::new()
        .route(
            "/api/debug/conversations",
            get(list_conversations).fallback(proxy_to_upstream),
        )
        .route(
            "/api/debug/conversations/{id}/replay",
            post(replay).fallback(proxy_to_upstream),
        )
        .route(
            "/api/debug/conversations/{id}/turns",
            get(turns).fallback(proxy_to_upstream),
        )
}

/// `GET /api/debug/conversations`: the 100 most recent conversations with dispatches.
async fn list_conversations(
    State(state): State<SharedState>,
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
) -> Response {
    if Caller::from_request(&state, &headers).is_none() {
        return unauthorized_response();
    }
    match services.prompt_dispatch.list_conversation_summaries() {
        Ok(conversations) => {
            Json(json!({ "ok": true, "conversations": conversations })).into_response()
        }
        Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string()),
    }
}

/// `POST /api/debug/conversations/{id}/replay`. Body: `{ fromSeq, modelOverride? }`.
/// The model override is accepted and ignored, as the TypeScript ignores it.
async fn replay(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    if Caller::from_request(&state, &headers).is_none() {
        return unauthorized_response();
    }
    let parsed: Value = match serde_json::from_slice(&body) {
        Ok(value) => value,
        Err(_) => return error_response(StatusCode::BAD_REQUEST, "Invalid JSON body"),
    };
    let from_seq_raw = match &parsed {
        Value::Object(fields) => fields.get("fromSeq"),
        // `body.fromSeq` on `null` throws in the TypeScript, outside its try block.
        Value::Null => {
            return error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Cannot read properties of null (reading 'fromSeq')",
            )
        }
        _ => None,
    };
    let from_seq = js_number(from_seq_raw);
    if !(from_seq.is_finite() && from_seq.fract() == 0.0 && from_seq >= 1.0) {
        return error_response(StatusCode::BAD_REQUEST, "fromSeq must be an integer >= 1");
    }

    let store = state.messages.lock().await;
    match ReplayService::new(&store).replay_from(&id, from_seq as i64) {
        Ok(new_conversation_id) => Json(json!({
            "ok": true,
            "newConversationId": new_conversation_id,
        }))
        .into_response(),
        Err(error @ ReplayError::ConversationNotFound(_)) => {
            error_response(StatusCode::NOT_FOUND, &error.to_string())
        }
        Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string()),
    }
}

/// `GET /api/debug/conversations/{id}/turns?limit=&beforeSeq=`: one page of turns,
/// newest first in the page query and ascending in the response.
async fn turns(
    State(state): State<SharedState>,
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    RawQuery(query): RawQuery,
) -> Response {
    if Caller::from_request(&state, &headers).is_none() {
        return unauthorized_response();
    }
    match turns_body(&state, &services, &id, query.as_deref()).await {
        Ok(body) => Json(body).into_response(),
        Err(message) => error_response(StatusCode::INTERNAL_SERVER_ERROR, &message),
    }
}

async fn turns_body(
    state: &SharedState,
    services: &Services,
    id: &str,
    query: Option<&str>,
) -> Result<Value, String> {
    let limit = positive_int_or(query_value(query, "limit").as_deref(), 50).clamp(1, 200);
    let before_seq = positive_int_or(query_value(query, "beforeSeq").as_deref(), 0);

    // One row beyond the page tells whether another page exists.
    let mut dispatches: Vec<_> = services
        .prompt_dispatch
        .list_dispatches(&PromptDispatchFilter {
            conversation_id: Some(id.to_string()),
            limit: Some(limit + 1),
            before_turn_seq: (before_seq > 0).then_some(before_seq),
            ..Default::default()
        })
        .map_err(|error| error.to_string())?
        .into_iter()
        .filter(|dispatch| dispatch.turn_seq.is_some())
        .collect();
    dispatches.sort_by(|left, right| right.turn_seq.cmp(&left.turn_seq));
    let has_more = dispatches.len() as i64 > limit;
    dispatches.truncate(limit as usize);
    let next_before_seq = if has_more {
        dispatches.last().and_then(|dispatch| dispatch.turn_seq)
    } else {
        None
    };

    // The messages of the page: from the turn before the oldest one to the end of the span.
    let min_seq = dispatches
        .iter()
        .map(|dispatch| dispatch.turn_seq.unwrap_or(i64::MAX))
        .min()
        .unwrap_or(i64::MAX);
    let max_seq = dispatches
        .iter()
        .map(|dispatch| dispatch.turn_seq.unwrap_or(0))
        .max()
        .unwrap_or(0);
    let page_span = if min_seq <= max_seq {
        max_seq - min_seq + 2
    } else {
        0
    };
    let messages: Vec<StoredMessage> = if dispatches.is_empty() {
        Vec::new()
    } else {
        let store = state.messages.lock().await;
        store
            .list_messages_after_seq(
                id,
                (min_seq - 1).max(0),
                (page_span + 10).clamp(50, 1000),
                None,
            )
            .map_err(|error| error.to_string())?
    };
    let by_seq: HashMap<i64, &StoredMessage> = messages
        .iter()
        .filter_map(|message| message.seq.map(|seq| (seq, message)))
        .collect();

    // The agent reply is taken as the message after the user message.
    let mut turns: Vec<Value> = dispatches
        .iter()
        .map(|dispatch| {
            let seq = dispatch.turn_seq.unwrap_or(0);
            let user = by_seq.get(&seq);
            let agent = by_seq.get(&(seq + 1));
            json!({
                "seq": seq,
                "userPreview": match user {
                    Some(message) => preview(&message.content),
                    None => preview(&dispatch.prompt_preview),
                },
                "assistantPreview": agent.map(|message| preview(&message.content)).unwrap_or_default(),
                "modelName": dispatch.model_name,
                "promptTokens": dispatch.prompt_tokens,
                "completionTokens": dispatch.completion_tokens,
                "latencyMs": dispatch.latency_ms,
                "toolCalls": tool_calls(&dispatch.tool_calls_json),
                "memoryContext": dispatch.memory_context_json,
                "riskLevel": dispatch.risk_level.as_str(),
                "dispatchId": dispatch.id,
            })
        })
        .collect();
    turns.sort_by_key(|turn| turn["seq"].as_i64().unwrap_or(0));

    let returned = turns.len();
    Ok(json!({
        "ok": true,
        "turns": turns,
        "pagination": {
            "limit": limit,
            "returned": returned,
            "hasMore": has_more,
            "nextBeforeSeq": next_before_seq,
        },
    }))
}

/// `text.slice(0, 200)` by UTF-16 code units. A cut inside a surrogate pair gives
/// U+FFFD, since a Rust string cannot hold a lone surrogate.
fn preview(text: &str) -> String {
    let units: Vec<u16> = text.encode_utf16().take(PREVIEW_UNITS).collect();
    String::from_utf16_lossy(&units)
}

/// `JSON.parse(toolCallsJson)` when it is an array, else `[]`.
fn tool_calls(raw: &str) -> Value {
    match serde_json::from_str::<Value>(raw) {
        Ok(value @ Value::Array(_)) => value,
        _ => json!([]),
    }
}

#[cfg(test)]
mod tests {
    use axum::http::Method;
    use betaclaw_core::messages_store::{CreateConversationInput, MessageRole, SaveMessageInput};
    use betaclaw_core::stats::prompt_dispatch::{
        DispatchKind, DispatchStatus, RecordPromptDispatchInput, RiskLevel, TokensSource,
    };

    use super::super::test_support::{app, assert_keys, send, services_in, state_in, Scratch};
    use super::*;

    const OWNER: &str = "user-1";

    fn dispatch(conversation: &str, turn: i64, preview: &str) -> RecordPromptDispatchInput {
        RecordPromptDispatchInput {
            provider_id: "openai".into(),
            model_name: "gpt-test".into(),
            account_id: None,
            dispatch_kind: DispatchKind::Chat,
            prompt_tokens: 10,
            prompt_tokens_source: TokensSource::Exact,
            completion_tokens: 5,
            total_tokens: 15,
            status: DispatchStatus::Success,
            error_message: None,
            risk_level: RiskLevel::Low,
            risk_score: 0,
            risk_reasons: Vec::new(),
            prompt_preview: preview.into(),
            prompt_payload_json: "{}".into(),
            prompt_cost_usd: None,
            completion_cost_usd: None,
            total_cost_usd: Some(0.01),
            created_at: None,
            conversation_id: Some(conversation.into()),
            turn_seq: Some(turn),
            latency_ms: Some(120),
            tool_calls_json: None,
            memory_context_json: None,
        }
    }

    /// A conversation with four messages (seq 1 to 4) and dispatches for the user
    /// turns 1 and 3. Returns the conversation id.
    async fn seed(state: &SharedState, services: &Services) -> String {
        let store = state.messages.lock().await;
        let conversation = store
            .create_conversation(&CreateConversationInput {
                channel_type: "WebChat",
                title: Some("Debug"),
                user_id: Some(OWNER),
                persona_id: None,
                ..Default::default()
            })
            .expect("conversation");
        for (role, content) in [
            (MessageRole::User, "one"),
            (MessageRole::Agent, "two"),
            (MessageRole::User, "three"),
            (MessageRole::Agent, "four"),
        ] {
            store
                .save_message(&SaveMessageInput {
                    conversation_id: &conversation.id,
                    role,
                    content,
                    platform: "WebChat",
                    external_msg_id: None,
                    sender_name: None,
                    metadata: None,
                    client_message_id: None,
                })
                .expect("save message");
        }
        drop(store);
        services
            .prompt_dispatch
            .record_dispatch(dispatch(&conversation.id, 1, "first"))
            .expect("dispatch 1");
        services
            .prompt_dispatch
            .record_dispatch(dispatch(&conversation.id, 3, "third"))
            .expect("dispatch 3");
        conversation.id
    }

    #[tokio::test]
    async fn conversations_list_requires_a_caller_and_summarises_dispatches() {
        let scratch = Scratch::new();
        let state = state_in(&scratch, false);
        let services = services_in(&scratch);
        let router = app(&state, &services);
        let conversation = seed(&state, &services).await;

        let (status, body) =
            send(&router, Method::GET, "/api/debug/conversations", None, None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_keys(&body, &["error", "ok"]);

        let (status, body) = send(
            &router,
            Method::GET,
            "/api/debug/conversations",
            Some(OWNER),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_keys(&body, &["conversations", "ok"]);
        let summary = &body["conversations"][0];
        assert_eq!(summary["conversationId"], conversation.as_str());
        assert_eq!(summary["turnCount"], 2);
        assert_eq!(summary["totalTokens"], 30);
        assert_keys(
            summary,
            &[
                "conversationId",
                "lastActivity",
                "modelName",
                "totalCostUsd",
                "totalTokens",
                "turnCount",
            ],
        );
    }

    #[tokio::test]
    async fn replay_validates_the_body_and_copies_the_history() {
        let scratch = Scratch::new();
        let state = state_in(&scratch, false);
        let services = services_in(&scratch);
        let router = app(&state, &services);
        let conversation = seed(&state, &services).await;
        let uri = format!("/api/debug/conversations/{conversation}/replay");

        let (status, body) = send(&router, Method::POST, &uri, Some(OWNER), Some("{")).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "Invalid JSON body");

        for text in [r#"{}"#, r#"{"fromSeq":0}"#, r#"{"fromSeq":1.5}"#] {
            let (status, body) = send(&router, Method::POST, &uri, Some(OWNER), Some(text)).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{text}");
            assert_eq!(body["error"], "fromSeq must be an integer >= 1");
        }

        let (status, body) = send(
            &router,
            Method::POST,
            "/api/debug/conversations/missing/replay",
            Some(OWNER),
            Some(r#"{"fromSeq":3}"#),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_keys(&body, &["error", "ok"]);

        let (status, body) = send(
            &router,
            Method::POST,
            &uri,
            Some(OWNER),
            Some(r#"{"fromSeq":3}"#),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_keys(&body, &["newConversationId", "ok"]);
        assert_ne!(body["newConversationId"], conversation.as_str());

        let (status, _) = send(&router, Method::POST, &uri, None, Some(r#"{"fromSeq":3}"#)).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn turns_page_newest_first_and_return_ascending() {
        let scratch = Scratch::new();
        let state = state_in(&scratch, false);
        let services = services_in(&scratch);
        let router = app(&state, &services);
        let conversation = seed(&state, &services).await;
        let uri = format!("/api/debug/conversations/{conversation}/turns");

        let (status, body) = send(&router, Method::GET, &uri, None, None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_keys(&body, &["error", "ok"]);

        let (status, body) = send(
            &router,
            Method::GET,
            &format!("{uri}?limit=1"),
            Some(OWNER),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_keys(&body, &["ok", "pagination", "turns"]);
        assert_eq!(body["pagination"]["hasMore"], true);
        assert_eq!(body["pagination"]["nextBeforeSeq"], 3);
        assert_eq!(body["pagination"]["returned"], 1);
        let newest = &body["turns"][0];
        assert_eq!(newest["seq"], 3);
        assert_eq!(newest["userPreview"], "three");
        assert_eq!(newest["assistantPreview"], "four");
        assert_keys(
            newest,
            &[
                "assistantPreview",
                "completionTokens",
                "dispatchId",
                "latencyMs",
                "memoryContext",
                "modelName",
                "promptTokens",
                "riskLevel",
                "seq",
                "toolCalls",
                "userPreview",
            ],
        );

        let (status, body) = send(
            &router,
            Method::GET,
            &format!("{uri}?limit=5&beforeSeq=3"),
            Some(OWNER),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["pagination"]["hasMore"], false);
        assert_eq!(body["pagination"]["nextBeforeSeq"], Value::Null);
        assert_eq!(body["turns"][0]["seq"], 1);
        assert_eq!(body["turns"][0]["userPreview"], "one");
    }

    #[test]
    fn previews_cut_by_utf16_units() {
        let long = "a".repeat(250);
        assert_eq!(preview(&long).len(), 200);
        assert_eq!(preview("short"), "short");
        // "😀" is two UTF-16 units, so 199 ASCII characters plus the emoji fill 201
        // units and the cut lands inside the pair.
        let emoji_cut = format!("{}😀", "a".repeat(199));
        assert_eq!(preview(&emoji_cut), format!("{}\u{FFFD}", "a".repeat(199)));
    }
}
