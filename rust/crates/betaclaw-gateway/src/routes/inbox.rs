//! Inbox route.
//!
//! Port of `app/api/channels/inbox/route.ts` and the query contract in
//! `src/server/channels/inbox/contract.ts`. `GET` returns one page of the user's
//! conversations, newest first, and a cursor for the next page. `version=1`
//! keeps the deprecated shape and adds `Deprecation` and `Sunset` headers. Other
//! methods are proxied.
//!
//! Not ported: the TypeScript metrics and trace logs. `resync` only feeds those,
//! so the parameter is accepted and has no effect here.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};

use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use betaclaw_core::messages_store::{InboxCursor, InboxListInput, InboxListResult};
use serde_json::{json, Value};

use crate::auth_gate::{unauthorized_response, user_id_from_headers};
use crate::proxy::proxy_to_upstream;
use crate::routes::channel_support::parse_int_prefix;
use crate::state::SharedState;

const DEFAULT_LIMIT: i64 = 50;
const MAX_LIMIT: i64 = 100;
const RATE_WINDOW: Duration = Duration::from_secs(60);
/// `resolveDeprecationHeaders` in the TypeScript contract: 30 days from now.
const SUNSET_AFTER: Duration = Duration::from_secs(30 * 24 * 60 * 60);

pub fn router() -> Router<SharedState> {
    Router::new().route(
        "/api/channels/inbox",
        get(list_inbox).fallback(proxy_to_upstream),
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Version {
    V1,
    V2,
}

struct InboxRequest {
    version: Version,
    channel: Option<String>,
    query: Option<String>,
    limit: i64,
    cursor: Option<InboxCursor>,
}

/// `GET /api/channels/inbox`
async fn list_inbox(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let Some(user_id) = user_id_from_headers(&headers) else {
        return unauthorized_response();
    };
    let request = match parse_request(&params) {
        Ok(request) => request,
        Err(message) => return inbox_error(StatusCode::BAD_REQUEST, "INVALID_REQUEST", message),
    };
    if request.version == Version::V2 && !state.config.inbox_v2_enabled {
        return inbox_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "UNAVAILABLE",
            "Inbox v2 is temporarily disabled.",
        );
    }
    if let RateDecision::Limited { retry_after_ms } = state.inbox_rate_limiter.consume(
        &user_id,
        state.config.inbox_http_rate_limit_per_minute,
        Instant::now(),
    ) {
        return rate_limited(retry_after_ms);
    }

    let outcome = {
        let store = state.messages.lock().await;
        store.list_inbox(&InboxListInput {
            user_id: user_id.as_str(),
            channel: request.channel.as_deref(),
            query: request.query.as_deref(),
            limit: Some(request.limit),
            cursor: request.cursor,
        })
    };
    let result = match outcome {
        Ok(result) => result,
        Err(error) => {
            return inbox_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "UNAVAILABLE",
                &error.to_string(),
            )
        }
    };

    match request.version {
        Version::V1 => v1_response(&result),
        Version::V2 => Json(json!({
            "ok": true,
            "items": result.items,
            "page": {
                "limit": result.limit,
                "returned": result.items.len(),
                "hasMore": result.has_more,
                "nextCursor": encode_cursor(result.next_cursor.as_ref()),
                "totalMatched": result.total_matched,
            },
        }))
        .into_response(),
    }
}

/// Port of `resolveInboxListInput`. The error text is what the route answers with 400.
fn parse_request(params: &HashMap<String, String>) -> Result<InboxRequest, &'static str> {
    Ok(InboxRequest {
        version: parse_version(query_value(params, "version"))?,
        channel: trimmed(query_value(params, "channel")),
        query: trimmed(query_value(params, "q")),
        limit: parse_limit(query_value(params, "limit"))?,
        cursor: parse_cursor(query_value(params, "cursor"))?,
    })
}

/// A query value, where an empty string counts as absent (`searchParams.get(k) || undefined`).
fn query_value<'a>(params: &'a HashMap<String, String>, key: &str) -> Option<&'a str> {
    params
        .get(key)
        .map(String::as_str)
        .filter(|value| !value.is_empty())
}

fn trimmed(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn parse_version(raw: Option<&str>) -> Result<Version, &'static str> {
    match raw.unwrap_or("").trim().to_lowercase().as_str() {
        "" | "2" | "v2" => Ok(Version::V2),
        "1" | "v1" => Ok(Version::V1),
        _ => Err("version must be 1 or 2"),
    }
}

fn parse_limit(raw: Option<&str>) -> Result<i64, &'static str> {
    let Some(raw) = raw.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(DEFAULT_LIMIT);
    };
    match parse_int_prefix(raw) {
        Some(value) if value >= 1 => Ok(value.min(MAX_LIMIT)),
        _ => Err("limit must be a positive integer"),
    }
}

fn parse_cursor(raw: Option<&str>) -> Result<Option<InboxCursor>, &'static str> {
    const INVALID: &str = "cursor is invalid";
    let Some(raw) = raw.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let bytes = URL_SAFE_NO_PAD
        .decode(raw.trim_end_matches('='))
        .map_err(|_| INVALID)?;
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| INVALID)?;
    let field = |name: &str| {
        value
            .get(name)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(str::to_string)
    };
    match (field("updatedAt"), field("conversationId")) {
        (Some(updated_at), Some(conversation_id)) => Ok(Some(InboxCursor {
            updated_at,
            conversation_id,
        })),
        _ => Err(INVALID),
    }
}

/// Port of `encodeCursor`: base64url of the cursor's JSON, without padding.
fn encode_cursor(cursor: Option<&InboxCursor>) -> Option<String> {
    let cursor = cursor?;
    let json = serde_json::to_string(cursor).ok()?;
    Some(URL_SAFE_NO_PAD.encode(json))
}

fn v1_response(result: &InboxListResult) -> Response {
    let sunset_at: chrono::DateTime<chrono::Utc> = (SystemTime::now() + SUNSET_AFTER).into();
    let sunset = sunset_at.format("%a, %d %b %Y %H:%M:%S GMT").to_string();
    let body = json!({
        "ok": true,
        "items": result.items,
        "total": result.total_matched,
        "nextCursor": encode_cursor(result.next_cursor.as_ref()),
    });
    (
        [("Deprecation", "true"), ("Sunset", sunset.as_str())],
        Json(body),
    )
        .into_response()
}

fn inbox_error(status: StatusCode, code: &str, message: &str) -> Response {
    (
        status,
        Json(json!({ "ok": false, "error": { "code": code, "message": message } })),
    )
        .into_response()
}

fn rate_limited(retry_after_ms: u64) -> Response {
    let retry_after_seconds = retry_after_ms.div_ceil(1000);
    (
        StatusCode::TOO_MANY_REQUESTS,
        [("Retry-After", retry_after_seconds.to_string())],
        Json(json!({
            "ok": false,
            "error": { "code": "RATE_LIMITED", "message": "Too many inbox requests." },
        })),
    )
        .into_response()
}

/// Outcome of one rate-limit check.
pub enum RateDecision {
    Allowed,
    Limited { retry_after_ms: u64 },
}

/// Fixed one-minute window per user. Port of `consumeInboxRateLimit` in
/// `src/server/channels/inbox/rateLimit.ts`. Like the TypeScript original, the
/// counters live in one process only.
#[derive(Default)]
pub struct InboxRateLimiter {
    windows: Mutex<HashMap<String, RateWindow>>,
}

struct RateWindow {
    started: Instant,
    count: u32,
}

impl InboxRateLimiter {
    pub fn consume(&self, user_id: &str, limit: u32, now: Instant) -> RateDecision {
        let mut windows = self
            .windows
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let window = windows.entry(user_id.to_string()).or_insert(RateWindow {
            started: now,
            count: 0,
        });
        if now.duration_since(window.started) >= RATE_WINDOW {
            window.started = now;
            window.count = 0;
        }
        window.count += 1;
        if window.count <= limit {
            return RateDecision::Allowed;
        }
        let elapsed = now.duration_since(window.started);
        RateDecision::Limited {
            retry_after_ms: RATE_WINDOW.saturating_sub(elapsed).as_millis() as u64,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::routes::test_support::{assert_keys, send, state_with, ScratchDir};
    use crate::state::SharedState;
    use axum::body::Body;
    use axum::http::{HeaderMap, Method, Request};
    use serde_json::Value;
    use tower::ServiceExt;

    const USER: &str = "user-inbox";

    /// Creates a WebChat conversation for `USER` with the given title.
    async fn seed(state: &SharedState, external_chat_id: &str, title: &str) {
        state
            .messages
            .lock()
            .await
            .get_or_create_conversation("WebChat", external_chat_id, Some(title), Some(USER))
            .expect("seed conversation");
    }

    /// Like `send`, but also returns the response headers.
    async fn send_with_headers(state: &SharedState, uri: &str) -> (StatusCode, HeaderMap, Value) {
        let request = Request::builder()
            .method(Method::GET)
            .uri(uri)
            .header("x-betaclaw-user-id", USER)
            .body(Body::empty())
            .expect("valid request");
        let response = crate::routes::router()
            .with_state(state.clone())
            .oneshot(request)
            .await
            .expect("infallible service");
        let status = response.status();
        let headers = response.headers().clone();
        let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
            .await
            .expect("read body");
        (
            status,
            headers,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    #[tokio::test]
    async fn v2_returns_items_and_page_metadata() {
        let scratch = ScratchDir::new();
        let state = crate::routes::test_support::state_in(&scratch);
        seed(&state, "chat-a", "Alpha").await;
        seed(&state, "chat-b", "Beta").await;

        let (status, body) =
            send(&state, Method::GET, "/api/channels/inbox", Some(USER), None).await;

        assert_eq!(status, StatusCode::OK);
        assert_keys(&body, &["items", "ok", "page"]);
        assert_keys(
            &body["page"],
            &["hasMore", "limit", "nextCursor", "returned", "totalMatched"],
        );
        assert_eq!(body["items"].as_array().expect("array").len(), 2);
        assert_eq!(body["page"]["totalMatched"], 2);
        assert_eq!(body["page"]["hasMore"], false);
        assert!(body["page"]["nextCursor"].is_null());
    }

    #[tokio::test]
    async fn cursor_walks_through_the_pages() {
        let scratch = ScratchDir::new();
        let state = crate::routes::test_support::state_in(&scratch);
        seed(&state, "chat-a", "Alpha").await;
        seed(&state, "chat-b", "Beta").await;
        seed(&state, "chat-c", "Gamma").await;

        let (_, first) = send(
            &state,
            Method::GET,
            "/api/channels/inbox?limit=2",
            Some(USER),
            None,
        )
        .await;
        assert_eq!(first["items"].as_array().expect("array").len(), 2);
        assert_eq!(first["page"]["hasMore"], true);
        let cursor = first["page"]["nextCursor"]
            .as_str()
            .expect("cursor")
            .to_string();

        let uri = format!("/api/channels/inbox?limit=2&cursor={cursor}");
        let (status, second) = send(&state, Method::GET, &uri, Some(USER), None).await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(second["items"].as_array().expect("array").len(), 1);
        assert_eq!(second["page"]["hasMore"], false);
        // `COUNT(*) OVER()` runs under the same WHERE as the page, cursor included
        // (queries/inbox.ts), so the total counts the rows left after the cursor.
        assert_eq!(second["page"]["totalMatched"], 1);
        assert_eq!(first["page"]["totalMatched"], 3);
    }

    #[tokio::test]
    async fn v1_keeps_the_deprecated_shape_and_sends_deprecation_headers() {
        let scratch = ScratchDir::new();
        let state = crate::routes::test_support::state_in(&scratch);
        seed(&state, "chat-a", "Alpha").await;

        let (status, headers, body) =
            send_with_headers(&state, "/api/channels/inbox?version=1").await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            headers.get("deprecation").and_then(|v| v.to_str().ok()),
            Some("true")
        );
        assert!(headers.get("sunset").is_some(), "sunset header is set");
        assert_keys(&body, &["items", "nextCursor", "ok", "total"]);
        assert_eq!(body["total"], 1);
    }

    #[tokio::test]
    async fn invalid_query_values_answer_400_with_the_contract_message() {
        let scratch = ScratchDir::new();
        let state = crate::routes::test_support::state_in(&scratch);
        let cases = [
            ("/api/channels/inbox?version=3", "version must be 1 or 2"),
            (
                "/api/channels/inbox?limit=0",
                "limit must be a positive integer",
            ),
            (
                "/api/channels/inbox?cursor=bm90LWpzb24",
                "cursor is invalid",
            ),
        ];
        for (uri, message) in cases {
            let (status, body) = send(&state, Method::GET, uri, Some(USER), None).await;

            assert_eq!(status, StatusCode::BAD_REQUEST, "{uri}");
            assert_keys(&body, &["error", "ok"]);
            assert_keys(&body["error"], &["code", "message"]);
            assert_eq!(body["error"]["code"], "INVALID_REQUEST", "{uri}");
            assert_eq!(body["error"]["message"], message, "{uri}");
        }
    }

    #[tokio::test]
    async fn v2_answers_503_when_disabled_but_v1_still_works() {
        let scratch = ScratchDir::new();
        let state = state_with(&scratch, |config| config.inbox_v2_enabled = false);

        let (status, body) =
            send(&state, Method::GET, "/api/channels/inbox", Some(USER), None).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_keys(&body, &["error", "ok"]);
        assert_eq!(body["error"]["code"], "UNAVAILABLE");
        assert_eq!(
            body["error"]["message"],
            "Inbox v2 is temporarily disabled."
        );

        let (v1_status, _) = send(
            &state,
            Method::GET,
            "/api/channels/inbox?version=1",
            Some(USER),
            None,
        )
        .await;
        assert_eq!(v1_status, StatusCode::OK);
    }

    #[tokio::test]
    async fn requests_over_the_limit_answer_429_with_retry_after() {
        let scratch = ScratchDir::new();
        let state = state_with(&scratch, |config| {
            config.inbox_http_rate_limit_per_minute = 2;
        });

        for _ in 0..2 {
            let (status, _, _) = send_with_headers(&state, "/api/channels/inbox").await;
            assert_eq!(status, StatusCode::OK);
        }
        let (status, headers, body) = send_with_headers(&state, "/api/channels/inbox").await;

        assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
        let retry_after: u64 = headers
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse().ok())
            .expect("numeric Retry-After");
        assert!((1..=60).contains(&retry_after));
        assert_eq!(body["error"]["code"], "RATE_LIMITED");
        assert_eq!(body["error"]["message"], "Too many inbox requests.");
    }

    #[tokio::test]
    async fn without_a_user_the_inbox_is_unauthorized() {
        let scratch = ScratchDir::new();
        let state = crate::routes::test_support::state_in(&scratch);

        let (status, body) = send(&state, Method::GET, "/api/channels/inbox", None, None).await;

        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_keys(&body, &["error", "ok"]);
    }

    #[test]
    fn rate_limiter_resets_after_the_window() {
        let limiter = InboxRateLimiter::default();
        let start = Instant::now();
        assert!(matches!(
            limiter.consume("u", 1, start),
            RateDecision::Allowed
        ));
        assert!(matches!(
            limiter.consume("u", 1, start),
            RateDecision::Limited { .. }
        ));
        let later = start + RATE_WINDOW;
        assert!(matches!(
            limiter.consume("u", 1, later),
            RateDecision::Allowed
        ));
    }
}
