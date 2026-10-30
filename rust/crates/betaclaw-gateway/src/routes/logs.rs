//! Log routes.
//!
//! Port of `app/api/logs/route.ts` and `app/api/logs/ingest/route.ts`. The
//! response shapes, the `limit` clamping and the `nextCursor`/`hasMore` semantics
//! are part of the contract the logs view depends on.

use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;

use betaclaw_core::logging::repository::{LogCategory, LogFilter, LogLevel};

use crate::auth_gate::{unauthorized_response, user_id_from_headers};
use crate::state::SharedState;

const DEFAULT_LIMIT: usize = 200;
const MIN_LIMIT: usize = 1;
const MAX_LIMIT: usize = 1000;

pub fn router() -> Router<SharedState> {
    Router::new()
        .route("/api/logs", get(list_logs).delete(clear_logs))
        .route("/api/logs/ingest", post(ingest))
}

#[derive(Debug, Default, Deserialize)]
pub struct ListQuery {
    level: Option<String>,
    source: Option<String>,
    category: Option<String>,
    search: Option<String>,
    before: Option<String>,
    limit: Option<String>,
    /// Presence-only flags, matching `searchParams.has('sources')`.
    sources: Option<String>,
    categories: Option<String>,
}

fn parse_limit(raw: Option<&str>) -> usize {
    match raw.and_then(|value| value.trim().parse::<i64>().ok()) {
        Some(parsed) => {
            let clamped = parsed.clamp(MIN_LIMIT as i64, MAX_LIMIT as i64);
            clamped as usize
        }
        None => DEFAULT_LIMIT,
    }
}

/// `GET /api/logs`
async fn list_logs(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Query(query): Query<ListQuery>,
) -> Response {
    if user_id_from_headers(&headers).is_none() {
        return unauthorized_response();
    }
    // Wait for the repository instead of shedding the request: the TypeScript
    // route serves concurrent readers, so a 503 here was a behaviour change.
    let guard = state.logs.lock().await;

    if query.sources.is_some() {
        return match guard.get_sources() {
            Ok(sources) => (
                StatusCode::OK,
                Json(serde_json::json!({ "ok": true, "sources": sources })),
            )
                .into_response(),
            Err(error) => server_error(&error),
        };
    }
    if query.categories.is_some() {
        return match guard.get_categories() {
            Ok(categories) => (
                StatusCode::OK,
                Json(serde_json::json!({ "ok": true, "categories": categories })),
            )
                .into_response(),
            Err(error) => server_error(&error),
        };
    }

    let filter = LogFilter {
        level: query.level.as_deref().and_then(LogLevel::parse),
        source: query.source.clone(),
        category: query.category.as_deref().and_then(LogCategory::parse),
        search: query.search.clone(),
        limit: Some(parse_limit(query.limit.as_deref())),
        before: query.before.clone(),
    };

    let logs = match guard.list_logs(&filter) {
        Ok(logs) => logs,
        Err(error) => return server_error(&error),
    };
    let total = match guard.get_log_count(&LogFilter {
        level: filter.level,
        source: filter.source.clone(),
        category: filter.category,
        search: filter.search.clone(),
        before: None,
        limit: None,
    }) {
        Ok(total) => total,
        Err(error) => return server_error(&error),
    };
    // `getLogCount` ignores `limit`; the two counts differ only by the cursor.
    let page_window_count = match guard.get_log_count(&LogFilter {
        limit: None,
        ..filter.clone()
    }) {
        Ok(count) => count,
        Err(error) => return server_error(&error),
    };

    let has_more = page_window_count > logs.len() as i64;
    // The cursor is the oldest entry of the current page.
    let next_cursor = logs
        .first()
        .map(|entry| entry.created_at.clone())
        .filter(|value| !value.is_empty());

    (
        StatusCode::OK,
        Json(serde_json::json!({
            "ok": true,
            "logs": logs,
            "total": total,
            "page": {
                "limit": filter.limit,
                "before": filter.before,
                "returned": logs.len(),
                "hasMore": has_more,
                "nextCursor": next_cursor,
            },
        })),
    )
        .into_response()
}

/// `DELETE /api/logs`
async fn clear_logs(State(state): State<SharedState>, headers: HeaderMap) -> Response {
    if user_id_from_headers(&headers).is_none() {
        return unauthorized_response();
    }
    // Wait for the repository instead of shedding the request: the TypeScript
    // route serves concurrent readers, so a 503 here was a behaviour change.
    let guard = state.logs.lock().await;
    match guard.clear_logs() {
        Ok(deleted) => (
            StatusCode::OK,
            Json(serde_json::json!({ "ok": true, "deleted": deleted })),
        )
            .into_response(),
        Err(error) => server_error(&error),
    }
}

#[derive(Debug, Deserialize)]
pub struct IngestBody {
    #[serde(rename = "type")]
    event_type: Option<String>,
    message: Option<String>,
}

/// `POST /api/logs/ingest`
async fn ingest(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Json(body): Json<IngestBody>,
) -> Response {
    if user_id_from_headers(&headers).is_none() {
        return unauthorized_response();
    }
    let (Some(event_type), Some(message)) = (
        body.event_type.filter(|value| !value.is_empty()),
        body.message.filter(|value| !value.is_empty()),
    ) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "ok": false, "error": "type and message are required" })),
        )
            .into_response();
    };

    // Wait for the repository instead of shedding the request: the TypeScript
    // route serves concurrent readers, so a 503 here was a behaviour change.
    let guard = state.logs.lock().await;

    match betaclaw_core::logging::log_from_system_event(
        &guard,
        Some(&state.registry),
        &event_type,
        &message,
    ) {
        Ok(entry) => (
            StatusCode::OK,
            Json(serde_json::json!({ "ok": true, "entry": entry })),
        )
            .into_response(),
        Err(error) => server_error(&error),
    }
}

fn server_error(error: &betaclaw_core::logging::repository::LogRepositoryError) -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(serde_json::json!({ "ok": false, "error": error.to_string() })),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::routes::test_support::{send, state_in, ScratchDir};
    use axum::http::Method;

    #[test]
    fn limit_is_clamped_like_typescript() {
        // Math.min(Math.max(parsed, 1), 1000)
        assert_eq!(parse_limit(None), DEFAULT_LIMIT);
        assert_eq!(parse_limit(Some("garbage")), DEFAULT_LIMIT);
        assert_eq!(parse_limit(Some("0")), MIN_LIMIT);
        assert_eq!(parse_limit(Some("-5")), MIN_LIMIT);
        assert_eq!(parse_limit(Some("5000")), MAX_LIMIT);
        assert_eq!(parse_limit(Some("42")), 42);
    }

    #[test]
    fn presence_flags_are_detected() {
        let query = ListQuery {
            sources: Some(String::new()),
            ..Default::default()
        };
        assert!(query.sources.is_some());
        assert!(query.categories.is_none());
    }

    #[tokio::test]
    async fn list_without_user_context_is_unauthorized() {
        let scratch = ScratchDir::new();
        let state = state_in(&scratch);
        let (status, body) = send(&state, Method::GET, "/api/logs", None, None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(body["error"], "Unauthorized");
    }

    #[tokio::test]
    async fn clear_without_user_context_is_unauthorized() {
        let scratch = ScratchDir::new();
        let state = state_in(&scratch);
        let (status, body) = send(&state, Method::DELETE, "/api/logs", None, None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(body["error"], "Unauthorized");
    }

    #[tokio::test]
    async fn ingest_without_user_context_is_unauthorized() {
        let scratch = ScratchDir::new();
        let state = state_in(&scratch);
        let body = r#"{"type":"SYS","message":"probe"}"#;
        let (status, response) =
            send(&state, Method::POST, "/api/logs/ingest", None, Some(body)).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(response["error"], "Unauthorized");
    }
}
