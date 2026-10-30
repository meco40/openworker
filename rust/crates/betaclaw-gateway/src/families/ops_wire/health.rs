//! Health routes: `GET /api/health`, `GET /api/health/scheduler`,
//! `GET /api/health/world-model` and `GET /api/doctor`.
//!
//! Port of `app/api/health/route.ts`, `app/api/health/scheduler/route.ts`,
//! `app/api/health/world-model/route.ts` and `app/api/doctor/route.ts`.
//!
//! The health and doctor reports and the World-Model checks are TypeScript
//! aggregations over stores that have no Rust port yet, so they come from ports.
//! The scheduler probe reads the automation lease directly.

use axum::extract::Extension;
use axum::http::{HeaderMap, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use chrono::DateTime;
use serde_json::{json, Map, Value};
use std::sync::Arc;
use subtle::ConstantTimeEq;

use super::ops::memory_diagnostics_flag;
use super::{error_json, now_iso, require_user, Services};
use crate::state::SharedState;

pub(super) fn router() -> Router<SharedState> {
    Router::new()
        .route("/api/health", get(health))
        .route("/api/health/scheduler", get(scheduler))
        .route("/api/health/world-model", get(world_model))
        .route("/api/doctor", get(doctor))
}

/// `{ ok: true, ...report }`.
fn with_ok(report: Value) -> Value {
    let mut body = Map::new();
    body.insert("ok".to_string(), Value::Bool(true));
    if let Value::Object(fields) = report {
        body.extend(fields);
    }
    Value::Object(body)
}

/// `GET /api/health`
async fn health(
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    uri: Uri,
) -> Response {
    if let Err(response) = require_user(&headers) {
        return response;
    }
    match services
        .diagnostics
        .health(memory_diagnostics_flag(&uri))
        .await
    {
        Ok(report) => Json(with_ok(report)).into_response(),
        Err(error) => error_json(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

/// `GET /api/doctor`
async fn doctor(
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    uri: Uri,
) -> Response {
    if let Err(response) = require_user(&headers) {
        return response;
    }
    match services
        .diagnostics
        .doctor(memory_diagnostics_flag(&uri))
        .await
    {
        Ok(report) => Json(with_ok(report)).into_response(),
        Err(error) => error_json(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

/// `GET /api/health/world-model`. The status code follows the report: 503 for
/// `unavailable` (World Model disabled) and `unhealthy`, otherwise 200.
async fn world_model(Extension(services): Extension<Arc<Services>>) -> Response {
    let scheduler = super::ops::automation_metrics(&services).await;
    match services.world_model.health(scheduler).await {
        Ok(report) => {
            let status = match report.get("status").and_then(Value::as_str) {
                Some("unavailable" | "unhealthy") => StatusCode::SERVICE_UNAVAILABLE,
                _ => StatusCode::OK,
            };
            (status, Json(report)).into_response()
        }
        Err(error) => error_json(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

/// The scheduler probe's token check. Without a configured token every caller
/// is admitted, as in TypeScript.
fn scheduler_authorized(expected: &str, headers: &HeaderMap) -> bool {
    if expected.is_empty() {
        return true;
    }
    let provided = headers
        .get("x-scheduler-health-token")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .unwrap_or("");
    !provided.is_empty()
        && expected.len() == provided.len()
        && bool::from(expected.as_bytes().ct_eq(provided.as_bytes()))
}

/// `GET /api/health/scheduler`. Public route. It answers 401 only when a token is
/// configured and the header does not match.
async fn scheduler(Extension(services): Extension<Arc<Services>>, headers: HeaderMap) -> Response {
    if !scheduler_authorized(&services.scheduler.token, &headers) {
        return error_json(StatusCode::UNAUTHORIZED, "Unauthorized");
    }

    let lease = match services.automation.lock().await.get_lease_state() {
        Ok(lease) => lease,
        Err(error) => return error_json(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    };
    let settings = &services.scheduler;
    let age_ms = lease
        .as_ref()
        .and_then(|lease| DateTime::parse_from_rfc3339(lease.updated_at.trim()).ok())
        .map(|updated| (chrono::Utc::now().timestamp_millis() - updated.timestamp_millis()).max(0));
    let healthy = lease.is_some()
        && age_ms
            .is_some_and(|age| age <= i64::try_from(settings.stale_after_ms).unwrap_or(i64::MAX));

    let mut body = json!({
        "ok": healthy,
        "healthy": healthy,
        "source": "automation_scheduler_lease",
        "scheduler": {
            "singletonKey": lease.as_ref().map(|l| l.singleton_key.clone()),
            "instanceId": lease.as_ref().map(|l| l.instance_id.clone()),
            "heartbeatAt": lease.as_ref().map(|l| l.heartbeat_at.clone()),
            "updatedAt": lease.as_ref().map(|l| l.updated_at.clone()),
            "ageMs": age_ms,
            "leaseTtlMs": settings.lease_ttl_ms,
            "tickIntervalMs": settings.tick_interval_ms,
            "staleAfterMs": settings.stale_after_ms,
        },
        "checkedAt": now_iso(),
    });
    let status = if healthy {
        StatusCode::OK
    } else {
        let message = if lease.is_none() {
            "Scheduler heartbeat not found."
        } else {
            "Scheduler heartbeat is stale."
        };
        if let Some(object) = body.as_object_mut() {
            object.insert("error".to_string(), Value::String(message.to_string()));
        }
        StatusCode::SERVICE_UNAVAILABLE
    };
    (status, Json(body)).into_response()
}

#[cfg(test)]
mod tests {
    use axum::http::Method;

    use crate::families::ops_wire::test_support::{
        fake_services, scratch, send, services_unwired_diagnostics, services_with_env, state_in,
        with_fake_diagnostics,
    };

    #[tokio::test]
    async fn health_without_user_is_unauthorized() {
        let scratch = scratch();
        let state = state_in(&scratch);
        let services = fake_services(&scratch);
        let (status, body) = send(&state, &services, Method::GET, "/api/health", &[], None).await;
        assert_eq!(status, 401);
        assert_eq!(
            body,
            serde_json::json!({ "ok": false, "error": "Unauthorized" })
        );
    }

    #[tokio::test]
    async fn health_merges_the_report_under_ok() {
        let scratch = scratch();
        let state = state_in(&scratch);
        let services = with_fake_diagnostics(&scratch);
        let headers = [("x-betaclaw-user-id", "user-a")];
        let (status, body) = send(
            &state,
            &services,
            Method::GET,
            "/api/health",
            &headers,
            None,
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(body["ok"], true);
        assert_eq!(body["status"], "ok");
        assert!(body["checks"].is_array());
    }

    #[tokio::test]
    async fn health_without_a_port_is_a_500() {
        let scratch = scratch();
        let state = state_in(&scratch);
        let services = services_unwired_diagnostics(&scratch);
        let headers = [("x-betaclaw-user-id", "user-a")];
        let (status, body) = send(
            &state,
            &services,
            Method::GET,
            "/api/health",
            &headers,
            None,
        )
        .await;
        assert_eq!(status, 500);
        assert_eq!(body["ok"], false);
        assert!(body["error"].as_str().unwrap().contains("not wired"));
    }

    #[tokio::test]
    async fn doctor_without_user_is_unauthorized() {
        let scratch = scratch();
        let state = state_in(&scratch);
        let services = fake_services(&scratch);
        let (status, body) = send(&state, &services, Method::GET, "/api/doctor", &[], None).await;
        assert_eq!(status, 401);
        assert_eq!(body["error"], "Unauthorized");
    }

    #[tokio::test]
    async fn doctor_merges_the_report_under_ok() {
        let scratch = scratch();
        let state = state_in(&scratch);
        let services = with_fake_diagnostics(&scratch);
        let headers = [("x-betaclaw-user-id", "user-a")];
        let (status, body) = send(
            &state,
            &services,
            Method::GET,
            "/api/doctor",
            &headers,
            None,
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(body["ok"], true);
        assert_eq!(body["findings"], serde_json::json!([]));
    }

    #[tokio::test]
    async fn scheduler_without_a_lease_is_503() {
        let scratch = scratch();
        let state = state_in(&scratch);
        let services = fake_services(&scratch);
        let (status, body) = send(
            &state,
            &services,
            Method::GET,
            "/api/health/scheduler",
            &[],
            None,
        )
        .await;
        assert_eq!(status, 503);
        assert_eq!(body["ok"], false);
        assert_eq!(body["healthy"], false);
        assert_eq!(body["error"], "Scheduler heartbeat not found.");
        assert_eq!(body["source"], "automation_scheduler_lease");
        assert_eq!(body["scheduler"]["ageMs"], serde_json::Value::Null);
        assert_eq!(body["scheduler"]["leaseTtlMs"], 30_000);
    }

    #[tokio::test]
    async fn scheduler_rejects_a_wrong_token_with_401() {
        let scratch = scratch();
        let state = state_in(&scratch);
        let services = std::sync::Arc::new(services_with_env(
            &scratch,
            &[("SCHEDULER_HEALTH_TOKEN", "expected-token")],
        ));
        let (status, body) = send(
            &state,
            &services,
            Method::GET,
            "/api/health/scheduler",
            &[("x-scheduler-health-token", "wrong")],
            None,
        )
        .await;
        assert_eq!(status, 401);
        assert_eq!(
            body,
            serde_json::json!({ "ok": false, "error": "Unauthorized" })
        );
    }

    #[tokio::test]
    async fn world_model_without_a_pool_is_a_503() {
        let scratch = scratch();
        let state = state_in(&scratch);
        let services = fake_services(&scratch);
        let (status, body) = send(
            &state,
            &services,
            Method::GET,
            "/api/health/world-model",
            &[],
            None,
        )
        .await;
        // `app/api/health/world-model/route.ts` answers 503 with `unavailable` (not enabled)
        // or `unhealthy` (no pool); the body has no `ok` key.
        assert_eq!(status, 503);
        assert!(matches!(
            body["status"].as_str(),
            Some("unavailable" | "unhealthy")
        ));
    }
}
