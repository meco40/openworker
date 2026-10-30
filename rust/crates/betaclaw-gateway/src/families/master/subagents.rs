//! Port of `app/api/master/subagents/route.ts` (GET) and
//! `app/api/master/subagents/[id]/route.ts` (GET, PATCH) over
//! `src/server/master/delegation/sessionService.ts` and the sessions store.
//!
//! Both routes are gated by `MASTER_SUBAGENT_SESSIONS_ENABLED`, checked before the
//! identity, as in the source.

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Extension, Path};
use axum::http::{HeaderMap, StatusCode, Uri};
use axum::response::IntoResponse;
use axum::Json;
use betaclaw_core::master::delegation::session_service::{
    cancel_subagent_session, get_subagent_session_detail,
};
use betaclaw_core::master::feature_flags::is_master_subagent_sessions_enabled;
use serde_json::json;

use super::support::{
    bad_request, filled_field, json_body, query_of, scope_body, string_field, user_or_401,
    ApiError, Reply,
};
use super::Services;

/// `listSubagentSessions` default limit (`sessions.store.ts:94`).
const SESSION_LIST_LIMIT: i64 = 200;
/// `body.reason ?? 'cancelled'` of `subagents/[id]/route.ts:72`.
const DEFAULT_CANCEL_REASON: &str = "cancelled";

fn disabled() -> ApiError {
    ApiError::new(
        StatusCode::NOT_FOUND,
        "Master subagent sessions are disabled.",
    )
}

/// `GET /api/master/subagents` (`subagents/route.ts:9-30`).
pub(super) async fn list(
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    uri: Uri,
) -> Reply {
    if !is_master_subagent_sessions_enabled(&services.env) {
        return Err(disabled());
    }
    let user = user_or_401(&headers)?;
    let query = query_of(&uri);
    let repos = services.repos().await;
    let scope = repos.scope(&query, &user, None)?;
    let run_id = query.get("runId").filter(|value| !value.is_empty());
    let sessions = repos
        .master
        .list_subagent_sessions(&scope, run_id.as_deref(), SESSION_LIST_LIMIT)
        .map_err(bad_request)?;
    Ok(Json(json!({ "ok": true, "sessions": sessions })).into_response())
}

/// `GET /api/master/subagents/{id}` (`subagents/[id]/route.ts:25-48`). The session
/// detail is spread next to `ok`, as the source does.
pub(super) async fn get_session(
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    uri: Uri,
    Path(id): Path<String>,
) -> Reply {
    if !is_master_subagent_sessions_enabled(&services.env) {
        return Err(disabled());
    }
    let user = user_or_401(&headers)?;
    let repos = services.repos().await;
    let scope = repos.scope(&query_of(&uri), &user, None)?;
    let detail = get_subagent_session_detail(&*repos.master, &scope, &id)
        .map_err(bad_request)?
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Session not found"))?;
    Ok(Json(json!({
        "ok": true,
        "session": detail.session,
        "job": detail.job,
        "events": detail.events,
    }))
    .into_response())
}

/// `PATCH /api/master/subagents/{id}` (`subagents/[id]/route.ts:50-82`). The only
/// action is `cancel`.
pub(super) async fn cancel_session(
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    uri: Uri,
    Path(id): Path<String>,
    body: Bytes,
) -> Reply {
    if !is_master_subagent_sessions_enabled(&services.env) {
        return Err(disabled());
    }
    let user = user_or_401(&headers)?;
    let body = json_body(&body)?;
    if string_field(&body, "action").as_deref() != Some("cancel") {
        return Err(bad_request("Unsupported session action"));
    }
    let repos = services.repos().await;
    let scope = repos.scope(&query_of(&uri), &user, Some(&scope_body(&body)))?;
    let reason = filled_field(&body, "reason").unwrap_or_else(|| DEFAULT_CANCEL_REASON.into());
    let session = cancel_subagent_session(
        &*repos.master,
        &scope,
        &id,
        Some(reason.as_str()),
        &services.events,
    )
    .map_err(bad_request)?
    .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Session not found"))?;
    Ok(Json(json!({ "ok": true, "session": session })).into_response())
}

#[cfg(test)]
mod tests {
    use axum::http::{Method, StatusCode};
    use betaclaw_core::master::feature_flags::MasterEnv;

    use crate::families::master::test_support::{Harness, OWNER, SCOPE};

    #[tokio::test]
    async fn subagent_sessions_list_get_and_cancel() {
        let harness = Harness::new();
        let (status, body) = harness
            .send(
                Method::GET,
                &format!("/api/master/subagents{SCOPE}"),
                Some(OWNER),
                None,
            )
            .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["sessions"], serde_json::json!([]));

        let (status, body) = harness
            .send(
                Method::GET,
                &format!("/api/master/subagents/nope{SCOPE}"),
                Some(OWNER),
                None,
            )
            .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["error"], "Session not found");

        let (status, body) = harness
            .send(
                Method::PATCH,
                "/api/master/subagents/nope",
                Some(OWNER),
                Some(r#"{"workspaceId":"main","action":"pause"}"#),
            )
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "Unsupported session action");

        let (status, body) = harness
            .send(
                Method::PATCH,
                "/api/master/subagents/nope",
                Some(OWNER),
                Some(r#"{"workspaceId":"main","action":"cancel"}"#),
            )
            .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["error"], "Session not found");

        let (status, body) = harness
            .send(
                Method::GET,
                &format!("/api/master/subagents{SCOPE}"),
                None,
                None,
            )
            .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(body["error"], "Unauthorized");
    }

    #[tokio::test]
    async fn subagent_routes_honour_the_rollout_flag() {
        let env = MasterEnv::from([(
            "MASTER_SUBAGENT_SESSIONS_ENABLED".to_string(),
            "0".to_string(),
        )]);
        let harness = Harness::with_env(env);
        let (status, body) = harness
            .send(
                Method::GET,
                &format!("/api/master/subagents{SCOPE}"),
                Some(OWNER),
                None,
            )
            .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["error"], "Master subagent sessions are disabled.");
    }
}
