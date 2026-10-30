//! Control-plane metrics: `GET /api/control-plane/metrics`.
//!
//! Port of `app/api/control-plane/metrics/route.ts`. The route uses
//! `withResolvedUserContext`, so it never answers 401. A missing identity counts as
//! the legacy local user.
//!
//! Stores in Rust: the client registry (WebSocket sessions), the token-usage table,
//! the agent-room metrics, the automation scheduler. Ports: the vector node count,
//! the knowledge metrics, the inbox observability and the World-Model metrics.
//! Each falls back as its TypeScript call site does (`-1`, `null`).
//!
//! Not carried over: `ramUsageBytes` is `null`. The standard library has no
//! resident-set size, and the workspace has no crate that provides it.

use axum::extract::{Extension, State};
use axum::http::{HeaderMap, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use chrono::Local;
use serde_json::{json, Value};
use std::sync::Arc;

use super::ops::automation_metrics;
use super::{
    error_json, iso_from_ms, now_iso, query_param, user_id_from_headers_or_legacy, Services,
};
use crate::state::SharedState;

pub(super) fn router() -> Router<SharedState> {
    Router::new().route("/api/control-plane/metrics", get(metrics))
}

/// `new Date()` at local midnight, as the ISO string the route passes to the token store.
fn start_of_today_iso() -> String {
    let now = Local::now();
    now.date_naive()
        .and_hms_opt(0, 0, 0)
        .and_then(|midnight| midnight.and_local_timezone(Local).earliest())
        .map_or_else(
            || iso_from_ms(now.timestamp_millis()),
            |midnight| iso_from_ms(midnight.timestamp_millis()),
        )
}

/// `GET /api/control-plane/metrics`
async fn metrics(
    State(state): State<SharedState>,
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    uri: Uri,
) -> Response {
    let user_id = user_id_from_headers_or_legacy(&headers);
    let uptime_seconds = services.started_at.elapsed().as_secs();
    let active_ws_sessions = state.registry.connection_count();
    let to = now_iso();
    let from = start_of_today_iso();

    let tokens_today = match services
        .token_usage
        .lock()
        .await
        .get_total_tokens(Some(&from), Some(&to))
    {
        Ok(total) => total.total_tokens,
        Err(error) => return error_json(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    };
    let vector_node_count = services
        .control_plane
        .vector_node_count(user_id.clone())
        .await
        .unwrap_or(-1);

    let ram_usage_bytes = services
        .control_plane
        .ram_usage_bytes()
        .map(Value::from)
        .unwrap_or(Value::Null);

    if query_param(&uri, "scope").as_deref() == Some("shell") {
        return Json(json!({
            "ok": true,
            "metrics": {
                "uptimeSeconds": uptime_seconds,
                "activeWsSessions": active_ws_sessions,
                "tokensToday": tokens_today,
                "vectorNodeCount": vector_node_count,
                "ramUsageBytes": ram_usage_bytes,
                "generatedAt": now_iso(),
            },
        }))
        .into_response();
    }

    let metrics_user_id = user_id.clone();
    let agent_room = match state
        .messages
        .lock()
        .await
        .get_agent_room_swarm_metrics(&metrics_user_id)
    {
        Ok(metrics) => serde_json::to_value(metrics).unwrap_or(Value::Null),
        Err(error) => return error_json(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    };
    let automation = match automation_metrics(&services).await {
        Ok(metrics) => metrics,
        Err(error) => return error_json(StatusCode::INTERNAL_SERVER_ERROR, error),
    };
    let knowledge = services
        .control_plane
        .knowledge_metrics(metrics_user_id.clone())
        .await
        .unwrap_or(Value::Null);
    let world_model = services.world_model.metrics().await.unwrap_or(Value::Null);
    let inbox = services
        .control_plane
        .inbox_observability()
        .await
        .unwrap_or(Value::Null);

    Json(json!({
        "ok": true,
        "metrics": {
            "uptimeSeconds": uptime_seconds,
            "activeWsSessions": active_ws_sessions,
            "tokensToday": tokens_today,
            "vectorNodeCount": vector_node_count,
            "ramUsageBytes": ram_usage_bytes,
            "agentRoom": agent_room,
            "automation": automation,
            "inbox": inbox,
            "rooms": Value::Null,
            "knowledge": knowledge,
            "worldModel": world_model,
            "generatedAt": now_iso(),
        },
    }))
    .into_response()
}

#[cfg(test)]
mod tests {
    use axum::http::Method;

    use crate::families::ops_wire::test_support::{
        fake_services, scratch, send, services_unwired_world_model, state_in,
    };

    #[tokio::test]
    async fn shell_scope_needs_no_user_and_has_the_shell_keys() {
        let scratch = scratch();
        let state = state_in(&scratch);
        let services = fake_services(&scratch);
        let (status, body) = send(
            &state,
            &services,
            Method::GET,
            "/api/control-plane/metrics?scope=shell",
            &[],
            None,
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(body["ok"], true);
        let metrics = &body["metrics"];
        assert_eq!(metrics["activeWsSessions"], 0);
        assert_eq!(metrics["tokensToday"], 0);
        assert_eq!(metrics["vectorNodeCount"], -1);
        assert_eq!(metrics["ramUsageBytes"], serde_json::Value::Null);
        assert!(metrics["uptimeSeconds"].is_u64());
        assert!(metrics["generatedAt"].is_string());
    }

    #[tokio::test]
    async fn full_metrics_fall_back_where_a_port_is_missing() {
        let scratch = scratch();
        let state = state_in(&scratch);
        let services = services_unwired_world_model(&scratch);
        let headers = [("x-betaclaw-user-id", "user-a")];
        let (status, body) = send(
            &state,
            &services,
            Method::GET,
            "/api/control-plane/metrics",
            &headers,
            None,
        )
        .await;
        assert_eq!(status, 200);
        let metrics = &body["metrics"];
        assert_eq!(metrics["automation"]["activeRules"], 0);
        assert_eq!(
            metrics["automation"]["leaseAgeSeconds"],
            serde_json::Value::Null
        );
        assert_eq!(metrics["knowledge"], serde_json::Value::Null);
        assert_eq!(metrics["worldModel"], serde_json::Value::Null);
        // The inbox snapshot is productive (`ControlPlaneFigures`); rooms has no port yet.
        assert!(metrics["inbox"].is_object());
        assert_eq!(metrics["rooms"], serde_json::Value::Null);
        assert_eq!(metrics["vectorNodeCount"], -1);
        assert!(metrics.get("agentRoom").is_some());
    }
}
