//! Port of `app/api/automations/route.ts`, `metrics/route.ts`, `[id]/route.ts`,
//! `[id]/flow/route.ts`, `[id]/run/route.ts` and `[id]/runs/route.ts`.
//!
//! The rule store, the cron check, the flow validator and the flow compiler are in
//! `betaclaw_core::automation`. The answers keep the `{ ok, ... }` envelope of the
//! source. A run is queued here and executed by the scheduler, which is not wired yet.

use std::collections::HashMap;
use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Extension, Path as AxumPath, Query, State};
use axum::http::{header, HeaderMap};
use axum::response::Response;
use betaclaw_core::automation::flow_compiler::compile_flow;
use betaclaw_core::automation::flow_types::FlowGraph;
use betaclaw_core::automation::flow_validator::validate_flow_graph;
use betaclaw_core::automation::types::{CreateAutomationRuleInput, UpdateAutomationRuleInput};
use serde_json::{json, Value};

use super::access::{resolve, Access};
use super::wire::{internal, reply, text_key, Outcome};
use super::Services;
use crate::auth_gate::unauthorized_response;
use crate::state::SharedState;

const MIN_LIMIT: i64 = 1;
const MAX_LIMIT: i64 = 500;
/// `MAX_FLOW_GRAPH_BYTES` of the flow route.
const MAX_FLOW_GRAPH_BYTES: usize = 500 * 1024;
/// The default of `listRuns` in the repository (`runs.ts`).
const DEFAULT_RUN_LIMIT: i64 = 50;

/// `{ ok: false, error }` with the given status.
fn ok_error(status: u16, message: &str) -> Response {
    reply(status, json!({ "ok": false, "error": message }))
}

/// `parseOptionalLimit`: `parseInt` of the query value, clamped to 1..=500. `None` when
/// the value is absent or is not a number.
fn parse_limit(raw: Option<&String>) -> Option<i64> {
    let trimmed = raw?.trim_start();
    let (negative, digits) = match trimmed.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, trimmed.strip_prefix('+').unwrap_or(trimmed)),
    };
    let digits: String = digits.chars().take_while(char::is_ascii_digit).collect();
    if digits.is_empty() {
        return None;
    }
    let magnitude = digits.parse::<i64>().unwrap_or(i64::MAX);
    let value = if negative { -magnitude } else { magnitude };
    Some(value.clamp(MIN_LIMIT, MAX_LIMIT))
}

/// A JSON body as the automation routes read it: a parse error is an error.
fn parse_body(bytes: &Bytes) -> Result<Value, serde_json::Error> {
    serde_json::from_slice(bytes)
}

// ------------------------------------------------------------- /api/automations

/// `GET /api/automations?limit=`
pub async fn list_rules(
    State(state): State<SharedState>,
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    let Some(access) = resolve(&state, &headers) else {
        return unauthorized_response();
    };
    match services.automation.list_rules(&access.user_id) {
        Ok(mut rules) => {
            if let Some(limit) = parse_limit(query.get("limit")) {
                rules.truncate(limit as usize);
            }
            reply(200, json!({ "ok": true, "rules": rules }))
        }
        Err(error) => internal("Failed to list automation rules", error.into()),
    }
}

/// `POST /api/automations`
pub async fn create_rule(
    State(state): State<SharedState>,
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let Some(access) = resolve(&state, &headers) else {
        return unauthorized_response();
    };
    let body = match parse_body(&body) {
        Ok(body) => body,
        Err(error) => return ok_error(400, &error.to_string()),
    };
    let (Some(name), Some(cron), Some(prompt)) = (
        text_key(&body, "name"),
        text_key(&body, "cronExpression"),
        text_key(&body, "prompt"),
    ) else {
        return ok_error(400, "name, cronExpression and prompt are required");
    };
    let input = CreateAutomationRuleInput {
        user_id: access.user_id.clone(),
        name: name.to_string(),
        cron_expression: cron.to_string(),
        timezone: text_key(&body, "timezone").unwrap_or("UTC").to_string(),
        prompt: prompt.to_string(),
        enabled: body.get("enabled").and_then(Value::as_bool).unwrap_or(true),
        next_run_at: None,
    };
    match services.automation.create_rule(&input) {
        Ok(rule) => reply(200, json!({ "ok": true, "rule": rule })),
        Err(error) => ok_error(400, &error.to_string()),
    }
}

/// `GET /api/automations/metrics`: the counts and the scheduler lease.
pub async fn metrics(
    State(state): State<SharedState>,
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
) -> Response {
    let Some(_access) = resolve(&state, &headers) else {
        return unauthorized_response();
    };
    let metrics = services.automation.get_metrics();
    let lease = services.automation.get_lease_state();
    match (metrics, lease) {
        (Ok(metrics), Ok(lease)) => reply(
            200,
            json!({ "ok": true, "metrics": metrics, "leaseState": lease }),
        ),
        (Err(error), _) => internal("Failed to read automation metrics", error.into()),
        (_, Err(error)) => internal("Failed to read automation metrics", error.into()),
    }
}

// --------------------------------------------------------- /api/automations/{id}

/// `GET /api/automations/{id}`
pub async fn get_rule(
    State(state): State<SharedState>,
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> Response {
    let Some(access) = resolve(&state, &headers) else {
        return unauthorized_response();
    };
    match services.automation.get_rule(&id, &access.user_id) {
        Ok(Some(rule)) => reply(200, json!({ "ok": true, "rule": rule })),
        Ok(None) => ok_error(404, "Rule not found"),
        Err(error) => internal("Failed to fetch automation rule", error.into()),
    }
}

/// `PATCH /api/automations/{id}`
pub async fn update_rule(
    State(state): State<SharedState>,
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    body: Bytes,
) -> Response {
    let Some(access) = resolve(&state, &headers) else {
        return unauthorized_response();
    };
    let body = match parse_body(&body) {
        Ok(body) => body,
        Err(_) => return ok_error(400, "Failed to update automation rule"),
    };
    let text = |key: &str| body.get(key).and_then(Value::as_str).map(str::to_string);
    let patch = UpdateAutomationRuleInput {
        name: text("name"),
        cron_expression: text("cronExpression"),
        timezone: text("timezone"),
        prompt: text("prompt"),
        enabled: body.get("enabled").and_then(Value::as_bool),
        ..UpdateAutomationRuleInput::default()
    };
    match services
        .automation
        .update_rule(&id, &access.user_id, &patch)
    {
        Ok(Some(rule)) => reply(200, json!({ "ok": true, "rule": rule })),
        Ok(None) => ok_error(404, "Rule not found"),
        Err(error) => ok_error(400, &error.to_string()),
    }
}

/// `DELETE /api/automations/{id}`
pub async fn delete_rule(
    State(state): State<SharedState>,
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> Response {
    let Some(access) = resolve(&state, &headers) else {
        return unauthorized_response();
    };
    match services.automation.delete_rule(&id, &access.user_id) {
        Ok(true) => reply(200, json!({ "ok": true })),
        Ok(false) => ok_error(404, "Rule not found"),
        Err(error) => internal("Failed to delete automation rule", error.into()),
    }
}

// ------------------------------------------------------- /api/automations/{id}/flow

/// `GET /api/automations/{id}/flow`
pub async fn get_flow(
    State(state): State<SharedState>,
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> Response {
    let Some(access) = resolve(&state, &headers) else {
        return unauthorized_response();
    };
    match services.automation.get_flow_graph(&id, &access.user_id) {
        Ok(graph) => reply(200, json!({ "ok": true, "flowGraph": graph })),
        Err(error) => internal("Failed to read flow graph", error.into()),
    }
}

/// `PUT /api/automations/{id}/flow`: validates and compiles the graph, then stores it
/// with the prompt and schedule it compiles to.
pub async fn put_flow(
    State(state): State<SharedState>,
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    body: Bytes,
) -> Response {
    let Some(access) = resolve(&state, &headers) else {
        return unauthorized_response();
    };
    put_flow_inner(&services, &access, &id, &headers, &body)
        .unwrap_or_else(|fault| internal("Failed to save flow graph", fault))
}

fn put_flow_inner(
    services: &Services,
    access: &Access,
    id: &str,
    headers: &HeaderMap,
    body: &Bytes,
) -> Outcome {
    let declared = headers
        .get(header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0);
    if declared > MAX_FLOW_GRAPH_BYTES {
        return Ok(ok_error(413, "Payload too large (max 500 KB)"));
    }
    let parsed = match parse_body(body) {
        Ok(parsed) => parsed,
        Err(_) => return Ok(ok_error(400, "Invalid JSON body")),
    };
    let graph_value = match parsed.get("flowGraph") {
        Some(value) if value.is_object() => value.clone(),
        _ => return Ok(ok_error(400, "flowGraph is required")),
    };
    let graph: FlowGraph = match serde_json::from_value(graph_value) {
        Ok(graph) => graph,
        Err(error) => {
            return Ok(reply(
                422,
                json!({
                    "ok": false,
                    "errors": [{ "code": "INVALID_NODE_CONFIG", "message": error.to_string() }],
                }),
            ))
        }
    };
    let validation = validate_flow_graph(&graph);
    if !validation.valid {
        return Ok(reply(
            422,
            json!({ "ok": false, "errors": validation.errors }),
        ));
    }
    let compiled = compile_flow(&graph);
    Ok(
        match services
            .automation
            .save_flow_graph(id, &access.user_id, &graph, &compiled)?
        {
            Some(rule) => reply(200, json!({ "ok": true, "rule": rule })),
            None => ok_error(404, "Automation rule not found"),
        },
    )
}

// ------------------------------------------------------------- run and runs

/// `POST /api/automations/{id}/run`: queues a run for immediate execution.
pub async fn run_rule(
    State(state): State<SharedState>,
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> Response {
    let Some(access) = resolve(&state, &headers) else {
        return unauthorized_response();
    };
    match services.automation.create_manual_run(&id, &access.user_id) {
        Ok(run) => reply(200, json!({ "ok": true, "run": run })),
        Err(error) => ok_error(400, &error.to_string()),
    }
}

/// `GET /api/automations/{id}/runs?limit=`
pub async fn list_runs(
    State(state): State<SharedState>,
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    let Some(access) = resolve(&state, &headers) else {
        return unauthorized_response();
    };
    let limit = parse_limit(query.get("limit")).unwrap_or(DEFAULT_RUN_LIMIT);
    match services.automation.list_runs(&id, &access.user_id, limit) {
        Ok(runs) => reply(200, json!({ "ok": true, "runs": runs })),
        Err(error) => internal("Failed to list automation runs", error.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::families::tasks::ports::{NoSkills, UnwiredRuntime};
    use crate::families::tasks::test_support::{fixture, fixture_with, send};
    use axum::http::{Method, StatusCode};

    fn rule_body() -> String {
        json!({
            "name": "Daily",
            "cronExpression": "0 9 * * *",
            "prompt": "Say hello",
            "timezone": "UTC",
        })
        .to_string()
    }

    #[test]
    fn limits_follow_parse_int_and_are_clamped() {
        assert_eq!(parse_limit(Some(&"25".to_string())), Some(25));
        assert_eq!(parse_limit(Some(&"  7abc".to_string())), Some(7));
        assert_eq!(parse_limit(Some(&"0".to_string())), Some(1));
        assert_eq!(parse_limit(Some(&"9999".to_string())), Some(500));
        assert_eq!(parse_limit(Some(&"x".to_string())), None);
        assert_eq!(parse_limit(None), None);
    }

    #[tokio::test]
    async fn rule_crud_roundtrip() {
        let fixture = fixture();
        let (status, created) = send(
            &fixture,
            Method::POST,
            "/api/automations",
            Some("user-1"),
            Some(&rule_body()),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(created["ok"], true);
        let id = created["rule"]["id"].as_str().unwrap().to_string();
        assert_eq!(created["rule"]["cronExpression"], "0 9 * * *");

        let uri = format!("/api/automations/{id}");
        let (status, fetched) = send(&fixture, Method::GET, &uri, Some("user-1"), None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(fetched["rule"]["name"], "Daily");

        let (status, patched) = send(
            &fixture,
            Method::PATCH,
            &uri,
            Some("user-1"),
            Some(r#"{"enabled":false}"#),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(patched["rule"]["enabled"], false);

        let (status, list) = send(
            &fixture,
            Method::GET,
            "/api/automations?limit=5",
            Some("user-1"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(list["rules"].as_array().unwrap().len(), 1);

        let (status, body) = send(&fixture, Method::DELETE, &uri, Some("user-1"), None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, json!({ "ok": true }));
        let (status, _) = send(&fixture, Method::GET, &uri, Some("user-1"), None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn a_bad_cron_expression_is_a_bad_request_with_the_service_message() {
        let fixture = fixture();
        let body =
            json!({ "name": "Bad", "cronExpression": "not cron", "prompt": "x" }).to_string();
        let (status, body) = send(
            &fixture,
            Method::POST,
            "/api/automations",
            Some("user-1"),
            Some(&body),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["ok"], false);
        assert_eq!(body["error"], "Invalid cron expression");

        let (status, body) = send(
            &fixture,
            Method::POST,
            "/api/automations",
            Some("user-1"),
            Some("{}"),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(
            body["error"],
            "name, cronExpression and prompt are required"
        );
    }

    #[tokio::test]
    async fn metrics_report_counts_and_the_lease() {
        let fixture = fixture();
        let (status, body) = send(
            &fixture,
            Method::GET,
            "/api/automations/metrics",
            Some("user-1"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["ok"], true);
        assert!(body["metrics"].get("activeRules").is_some());
        assert!(body["leaseState"].is_null());
    }

    #[tokio::test]
    async fn a_manual_run_is_queued_and_listed() {
        let fixture = fixture_with(Arc::new(UnwiredRuntime), Arc::new(NoSkills), |_| {});
        let (_, created) = send(
            &fixture,
            Method::POST,
            "/api/automations",
            Some("user-1"),
            Some(&rule_body()),
        )
        .await;
        let id = created["rule"]["id"].as_str().unwrap().to_string();

        let (status, run) = send(
            &fixture,
            Method::POST,
            &format!("/api/automations/{id}/run"),
            Some("user-1"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(run["run"]["status"], "queued");
        assert_eq!(run["run"]["triggerSource"], "manual");

        let (status, runs) = send(
            &fixture,
            Method::GET,
            &format!("/api/automations/{id}/runs"),
            Some("user-1"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(runs["runs"].as_array().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn a_flow_without_a_trigger_is_unprocessable() {
        let fixture = fixture();
        let (_, created) = send(
            &fixture,
            Method::POST,
            "/api/automations",
            Some("user-1"),
            Some(&rule_body()),
        )
        .await;
        let id = created["rule"]["id"].as_str().unwrap().to_string();
        let uri = format!("/api/automations/{id}/flow");

        let (status, body) = send(&fixture, Method::GET, &uri, Some("user-1"), None).await;
        assert_eq!(status, StatusCode::OK);
        assert!(body["flowGraph"].is_null());

        let graph = json!({ "flowGraph": { "version": 1, "nodes": [], "edges": [] } }).to_string();
        let (status, body) = send(&fixture, Method::PUT, &uri, Some("user-1"), Some(&graph)).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(body["ok"], false);
        assert_eq!(body["errors"][0]["code"], "NO_TRIGGER");

        let (status, body) = send(&fixture, Method::PUT, &uri, Some("user-1"), Some("{}")).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "flowGraph is required");
    }
}
