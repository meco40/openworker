//! Internal routes: the Graphiti Model-Hub adapter and the engineering snapshot
//! ingest.
//!
//! Port of `app/api/internal/model-hub/graphiti/[...path]/route.ts` (POST) and
//! `app/api/internal/stats/engineering/snapshots/route.ts` (POST). Both check their
//! own bearer or token header and do not use `withUserContext`, as in TypeScript.
//!
//! The Graphiti adapter dispatches through the Model Hub service on the `p1-graphiti`
//! profile. The ingest writes the engineering snapshot store. Each of the two keeps
//! the error shape of its TypeScript source: `{ error: { message, type } }` for the
//! adapter, `{ ok: false, error }` for the ingest.

use axum::body::Bytes;
use axum::extract::{Extension, Path, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use betaclaw_core::model_hub::openai_compatible::NOOP_ATTACHMENT_STORE;
use betaclaw_core::model_hub::runtime::get_model_hub_encryption_key;
use betaclaw_core::model_hub::service::gateway::NoopObserver;
use betaclaw_core::model_hub::service::refresh::NoCodexRefresh;
use betaclaw_core::model_hub::service::{ModelHubService, ServiceDependencies};
use betaclaw_core::model_hub::sqlite::SqliteModelHubRepository;
use betaclaw_core::model_hub::types::{
    GatewayAuditContext, GatewayAuditKind, GatewayMessage, GatewayRequest, GatewayResponse,
    GatewayRole,
};
use betaclaw_core::stats::engineering_snapshot_repository::{
    BaselineInput, GateRunInput, HarnessRunEvent, PrFact, RunStatus,
};
use betaclaw_core::stats::harness_rollout::GateStatus;
use chrono::{DateTime, Duration, Utc};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use subtle::ConstantTimeEq;

use super::{error_json, iso_from_ms, now_iso, Services};
use crate::model_hub_transport::ReqwestTransport;
use crate::state::SharedState;

pub(super) fn router() -> Router<SharedState> {
    Router::new()
        .route(
            "/api/internal/model-hub/graphiti/{*path}",
            post(graphiti_chat),
        )
        .route(
            "/api/internal/stats/engineering/snapshots",
            post(engineering_snapshots),
        )
}

// ---------------------------------------------------------------------------
// Graphiti Model-Hub adapter
// ---------------------------------------------------------------------------

const GRAPHITI_PROFILE_ID: &str = "p1-graphiti";

/// `errorResponse` of the adapter: `{ error: { message, type } }`.
fn gateway_error(message: &str, status: StatusCode) -> Response {
    (
        status,
        Json(json!({
            "error": { "message": message, "type": "model_hub_gateway_error" },
        })),
    )
        .into_response()
}

/// `bearer` of `hasValidBearerToken`: the token after `Bearer` and whitespace.
fn bearer_token(value: &str) -> Option<&str> {
    let (scheme, rest) = value.split_once(|c: char| c.is_ascii_whitespace())?;
    if scheme.eq_ignore_ascii_case("Bearer") {
        Some(rest.trim())
    } else {
        None
    }
}

fn bearer_matches(headers: &HeaderMap, expected: &str) -> bool {
    let authorization = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    let supplied = bearer_token(authorization).unwrap_or("");
    !supplied.is_empty()
        && supplied.len() == expected.len()
        && bool::from(supplied.as_bytes().ct_eq(expected.as_bytes()))
}

/// `textFromContent`: a string, or the text parts of an array, joined.
fn text_from_content(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|part| {
                let object = part.as_object()?;
                object
                    .get("text")
                    .and_then(Value::as_str)
                    .or_else(|| object.get("content").and_then(Value::as_str))
                    .map(str::to_string)
            })
            .collect(),
        _ => String::new(),
    }
}

/// `normalizeMessages`: only `system`, `user` and `assistant` entries survive.
fn normalize_messages(value: Option<&Value>) -> Vec<GatewayMessage> {
    let Some(entries) = value.and_then(Value::as_array) else {
        return Vec::new();
    };
    entries
        .iter()
        .filter_map(|entry| {
            let message = entry.as_object()?;
            let role = match message.get("role").and_then(Value::as_str)? {
                "system" => GatewayRole::System,
                "user" => GatewayRole::User,
                "assistant" => GatewayRole::Assistant,
                _ => return None,
            };
            Some(GatewayMessage {
                role,
                content: text_from_content(message.get("content")),
                attachments: None,
            })
        })
        .collect()
}

/// `responseFormatMimeType`: JSON for `json_object` and `json_schema`.
fn response_mime_type(format: Option<&Value>) -> Option<String> {
    match format?.get("type")?.as_str()? {
        "json_object" | "json_schema" => Some("application/json".to_string()),
        _ => None,
    }
}

/// `positiveNumber`.
fn positive_number(value: Option<&Value>) -> Option<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|number| number.is_finite() && *number > 0.0)
}

/// `nonNegativeNumber`.
fn non_negative_number(value: Option<&Value>) -> Option<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|number| number.is_finite() && *number >= 0.0)
}

/// `toOpenAIResponse`: the OpenAI chat-completion body for a successful dispatch.
fn openai_response(result: &GatewayResponse) -> Value {
    let tool_calls: Vec<Value> = result
        .function_calls
        .as_deref()
        .unwrap_or_default()
        .iter()
        .enumerate()
        .map(|(index, call)| {
            let arguments = match &call.args {
                Some(Value::String(text)) => text.clone(),
                Some(args) => args.to_string(),
                None => "{}".to_string(),
            };
            json!({
                "id": format!("call_graphiti_{}", index + 1),
                "type": "function",
                "function": { "name": call.name, "arguments": arguments },
            })
        })
        .collect();

    let digest = Sha256::digest(format!(
        "{}\u{0}{}",
        Utc::now().timestamp_millis(),
        result.model
    ));
    let digest_hex: String = digest.iter().take(12).map(|b| format!("{b:02x}")).collect();

    let mut message = json!({ "role": "assistant", "content": result.text });
    let finish_reason = if tool_calls.is_empty() {
        "stop"
    } else {
        if let Some(object) = message.as_object_mut() {
            object.insert("tool_calls".to_string(), Value::Array(tool_calls));
        }
        "tool_calls"
    };

    let mut body = json!({
        "id": format!("chatcmpl-graphiti-{digest_hex}"),
        "object": "chat.completion",
        "created": Utc::now().timestamp(),
        "model": result.model,
        "choices": [{ "index": 0, "message": message, "finish_reason": finish_reason }],
        "system_fingerprint": format!("model-hub:{}", result.provider),
    });
    if let (Some(usage), Some(object)) = (&result.usage, body.as_object_mut()) {
        object.insert(
            "usage".to_string(),
            json!({
                "prompt_tokens": usage.prompt_tokens,
                "completion_tokens": usage.completion_tokens,
                "total_tokens": usage.total_tokens,
            }),
        );
    }
    body
}

/// `POST /api/internal/model-hub/graphiti/{*path}`
async fn graphiti_chat(
    State(state): State<SharedState>,
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    Path(path): Path<String>,
    body: Bytes,
) -> Response {
    if services.graphiti_token.is_empty() {
        return gateway_error(
            "Graphiti Model-Hub adapter token is not configured.",
            StatusCode::SERVICE_UNAVAILABLE,
        );
    }
    if !bearer_matches(&headers, &services.graphiti_token) {
        return gateway_error("Unauthorized.", StatusCode::UNAUTHORIZED);
    }
    if path != "v1/chat/completions" && path != "chat/completions" {
        return gateway_error(
            "Only the chat completions endpoint is available.",
            StatusCode::NOT_FOUND,
        );
    }

    let parsed: Value = match serde_json::from_slice(&body) {
        Ok(value) => value,
        Err(_) => {
            return gateway_error("Request body must be valid JSON.", StatusCode::BAD_REQUEST)
        }
    };
    let fields = parsed.as_object().cloned().unwrap_or_default();
    let messages = normalize_messages(fields.get("messages"));
    if messages.is_empty() {
        return gateway_error("messages must not be empty.", StatusCode::BAD_REQUEST);
    }

    let repository = match SqliteModelHubRepository::open(&services.model_hub_db_path) {
        Ok(repository) => repository,
        Err(error) => return gateway_error(&error.to_string(), StatusCode::INTERNAL_SERVER_ERROR),
    };
    let transport = ReqwestTransport::with_client(state.upstream.clone());
    let service = ModelHubService::new(
        &repository,
        ServiceDependencies {
            transport: &transport,
            attachments: &NOOP_ATTACHMENT_STORE,
            observer: &NoopObserver,
            env: &services.env,
            codex: &NoCodexRefresh,
        },
    );
    let active_models = match service.list_pipeline(GRAPHITI_PROFILE_ID) {
        Ok(entries) => entries
            .into_iter()
            .filter(|entry| entry.status == betaclaw_core::model_hub::types::PipelineStatus::Active)
            .collect::<Vec<_>>(),
        Err(error) => return gateway_error(&error.to_string(), StatusCode::INTERNAL_SERVER_ERROR),
    };
    let Some(primary) = active_models.first() else {
        return gateway_error(
            &format!(
                "No active Graphiti JSON model is configured in Model Hub profile {GRAPHITI_PROFILE_ID}."
            ),
            StatusCode::SERVICE_UNAVAILABLE,
        );
    };
    let encryption_key = match get_model_hub_encryption_key(&services.env) {
        Ok(key) => key,
        Err(error) => return gateway_error(&error.to_string(), StatusCode::INTERNAL_SERVER_ERROR),
    };

    let request = GatewayRequest {
        model: primary.model_name.clone(),
        messages,
        max_tokens: positive_number(fields.get("max_tokens")).map(|value| value as i64),
        temperature: non_negative_number(fields.get("temperature")),
        reasoning_effort: None,
        stream: None,
        system_instruction: None,
        // Graphiti receives structured JSON. The profile's active priority order is the
        // only source of truth for the model, so `modelOverride` below pins it.
        tools: fields.get("tools").and_then(Value::as_array).cloned(),
        response_mime_type: response_mime_type(fields.get("response_format")),
        response_format: fields.get("response_format").cloned(),
        audit_context: Some(GatewayAuditContext {
            kind: GatewayAuditKind::KnowledgeExtraction,
            conversation_id: None,
            turn_seq: None,
            memory_context: None,
            task_id: None,
            step_id: None,
            node_id: None,
        }),
    };
    let options = betaclaw_core::model_hub::service::types::DispatchWithFallbackOptions {
        model_override: Some(primary.model_name.clone()),
        ..Default::default()
    };

    let result = match service
        .dispatch_with_fallback(
            GRAPHITI_PROFILE_ID,
            &encryption_key,
            &request,
            Some(&options),
        )
        .await
    {
        Ok(result) => result,
        Err(error) => return gateway_error(&error.to_string(), StatusCode::INTERNAL_SERVER_ERROR),
    };
    if !result.ok {
        let message = result
            .error
            .clone()
            .unwrap_or_else(|| "Model Hub dispatch failed.".to_string());
        return gateway_error(&message, StatusCode::BAD_GATEWAY);
    }
    Json(openai_response(&result)).into_response()
}

// ---------------------------------------------------------------------------
// Engineering snapshot ingest
// ---------------------------------------------------------------------------

const MAX_CLOCK_SKEW_MS: i64 = 15 * 60 * 1000;
const RATE_WINDOW_MS: i64 = 60 * 1000;
const MAX_REQUESTS_PER_WINDOW: usize = 12;
const HARNESS_RETENTION_DAYS: i64 = 90;

/// A parsed snapshot row.
struct SnapshotRow {
    window_days: u32,
    source: String,
    generated_at: String,
    payload: Value,
}

/// A parsed rollout baseline, ready for the store.
struct BaselineRow {
    input: BaselineInput,
}

/// The parsed body of one ingest request.
struct IngestBody {
    snapshots: Vec<SnapshotRow>,
    pr_facts: Vec<PrFact>,
    events: Vec<HarnessRunEvent>,
    baseline: Option<BaselineRow>,
    gate_run: Option<GateRunInput>,
}

/// `value || ''` as the ingest reads text fields.
fn text_of(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Number(number)) if number.as_f64() != Some(0.0) => number.to_string(),
        Some(Value::Bool(true)) => "true".to_string(),
        _ => String::new(),
    }
}

/// `a ?? b ?? ...`: the first present, non-null value.
fn first<'a>(row: &'a Map<String, Value>, keys: &[&str]) -> Option<&'a Value> {
    keys.iter()
        .filter_map(|key| row.get(*key))
        .find(|value| !value.is_null())
}

/// `value || fallback` for the numeric fields.
fn truthy(value: Option<&Value>) -> Option<&Value> {
    value.filter(|value| match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0),
        Value::String(text) => !text.is_empty(),
        _ => true,
    })
}

/// `Number(value)`, as JavaScript coerces it. `None` is `NaN`.
fn js_number(value: Option<&Value>) -> Option<f64> {
    match value {
        None => None,
        Some(Value::Null) => Some(0.0),
        Some(Value::Bool(flag)) => Some(f64::from(u8::from(*flag))),
        Some(Value::Number(number)) => number.as_f64(),
        Some(Value::String(text)) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                Some(0.0)
            } else {
                trimmed.parse::<f64>().ok()
            }
        }
        Some(_) => None,
    }
}

/// `asInt`: `Math.floor(Number(value))`, or the field error.
fn as_int(value: Option<&Value>, field: &str) -> Result<i64, String> {
    js_number(value)
        .filter(|number| number.is_finite())
        .map(|number| number.floor() as i64)
        .ok_or_else(|| format!("Invalid numeric field: {field}"))
}

/// `asIso`: the timestamp as `toISOString` writes it, or the field error.
fn as_iso(value: Option<&Value>) -> Result<String, String> {
    let text = text_of(value);
    DateTime::parse_from_rfc3339(text.trim())
        .map(|parsed| iso_from_ms(parsed.timestamp_millis()))
        .map_err(|_| "Invalid ISO timestamp field".to_string())
}

/// `asOptionalString`: the trimmed text, or `None` when empty.
fn as_optional_string(value: Option<&Value>) -> Option<String> {
    let text = text_of(value).trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

/// `redactRunUrl`: the origin and path of an absolute URL, without credentials,
/// query and fragment. `None` for anything that is not an absolute URL.
fn redact_run_url(input: Option<&str>) -> Option<String> {
    let input = input?;
    let (scheme, rest) = input.split_once("://")?;
    if scheme.is_empty()
        || !scheme
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "+-.".contains(c))
    {
        return None;
    }
    let rest = rest.split(['?', '#']).next().unwrap_or("");
    let (authority, path) = match rest.find('/') {
        Some(index) => (&rest[..index], &rest[index..]),
        None => (rest, "/"),
    };
    let host = authority.rsplit('@').next().unwrap_or("");
    if host.is_empty() {
        return None;
    }
    let url = format!("{}://{}{}", scheme.to_ascii_lowercase(), host, path);
    Some(url.chars().take(512).collect())
}

/// `redactErrorKind`: a short, lowercase kind, or the sensitive-error marker.
fn redact_error_kind(value: Option<String>) -> Option<String> {
    let raw = value?.to_lowercase();
    let mut normalized = String::new();
    for ch in raw.chars() {
        let mapped = if ch.is_ascii_alphanumeric() || "._:-".contains(ch) {
            ch
        } else {
            '-'
        };
        if mapped == '-' && normalized.ends_with('-') {
            continue;
        }
        normalized.push(mapped);
    }
    let trimmed: String = normalized.trim_matches('-').chars().take(64).collect();
    if trimmed.is_empty() {
        None
    } else if trimmed.contains("token") || trimmed.contains("secret") || trimmed.contains("key") {
        Some("redacted-sensitive-error".to_string())
    } else {
        Some(trimmed)
    }
}

/// `source`: the trimmed text, or the GitHub default.
fn source_of(value: Option<&Value>) -> String {
    let text = text_of(value).trim().to_string();
    if text.is_empty() {
        "github-snapshot".to_string()
    } else {
        text
    }
}

/// `asRecord` of an array element.
fn record<'a>(entry: &'a Value, message: &str) -> Result<&'a Map<String, Value>, String> {
    entry.as_object().ok_or_else(|| message.to_string())
}

fn parse_snapshots(body: &Map<String, Value>, now: &str) -> Result<Vec<SnapshotRow>, String> {
    body.get("snapshots")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .map(|entry| {
            let row = record(entry, "Invalid snapshots payload")?;
            let window_days = as_int(first(row, &["windowDays", "window_days"]), "windowDays")?;
            if window_days != 7 && window_days != 30 {
                return Err("windowDays must be 7 or 30".to_string());
            }
            let generated_at = as_iso(Some(
                first(row, &["generatedAt", "generated_at"])
                    .unwrap_or(&Value::String(now.to_string())),
            ))?;
            Ok(SnapshotRow {
                window_days: window_days as u32,
                source: source_of(row.get("source")),
                generated_at,
                payload: Value::Object(row.clone()),
            })
        })
        .collect()
}

fn parse_pr_facts(body: &Map<String, Value>) -> Result<Vec<PrFact>, String> {
    body.get("prFacts")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .map(|entry| {
            let row = record(entry, "Invalid prFacts payload")?;
            Ok(PrFact {
                pr_number: as_int(first(row, &["prNumber", "pr_number"]), "prNumber")?,
                created_at: as_iso(first(row, &["createdAt", "created_at"]))?,
                merged_at: as_iso(first(row, &["mergedAt", "merged_at"]))?,
                additions: as_int(
                    truthy(row.get("additions")).or(Some(&json!(0))),
                    "additions",
                )?,
                deletions: as_int(
                    truthy(row.get("deletions")).or(Some(&json!(0))),
                    "deletions",
                )?,
                first_pass_blocking: first(row, &["firstPassBlocking", "first_pass_blocking"])
                    .is_some_and(|value| truthy(Some(value)).is_some()),
                reverted: truthy(row.get("reverted")).is_some(),
            })
        })
        .collect()
}

fn parse_events(body: &Map<String, Value>) -> Result<Vec<HarnessRunEvent>, String> {
    body.get("events")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .map(|entry| {
            let row = record(entry, "Invalid events payload")?;
            let status = match text_of(row.get("status")).trim().to_lowercase().as_str() {
                "success" => RunStatus::Success,
                "cancelled" => RunStatus::Cancelled,
                "skipped" => RunStatus::Skipped,
                _ => RunStatus::Failure,
            };
            let commit_sha = as_optional_string(first(row, &["commitSha", "commit_sha"]))
                .filter(|sha| {
                    sha.len() >= 7 && sha.len() <= 40 && sha.chars().all(|c| c.is_ascii_hexdigit())
                })
                .map(|sha| sha.to_lowercase());
            let service_name = text_of(first(row, &["serviceName", "service_name"]));
            let lane = text_of(row.get("lane")).trim().to_string();
            Ok(HarnessRunEvent {
                trace_id: as_optional_string(first(row, &["traceId", "trace_id"])),
                span_id: as_optional_string(first(row, &["spanId", "span_id"])),
                service_name: match service_name.trim() {
                    "" => "github-actions".to_string(),
                    name => name.to_string(),
                },
                domain: as_optional_string(row.get("domain")),
                lane: if lane.is_empty() {
                    "unknown".to_string()
                } else {
                    lane
                },
                scenario: as_optional_string(row.get("scenario")),
                status,
                started_at: as_iso(first(row, &["startedAt", "started_at"]))?,
                finished_at: as_iso(first(row, &["finishedAt", "finished_at"]))?,
                duration_ms: as_int(
                    Some(first(row, &["durationMs", "duration_ms"]).unwrap_or(&json!(0))),
                    "durationMs",
                )?
                .max(0),
                worktree_id: as_optional_string(first(row, &["worktreeId", "worktree_id"])),
                commit_sha,
                error_kind: redact_error_kind(as_optional_string(first(
                    row,
                    &["errorKind", "error_kind"],
                ))),
                run_url: redact_run_url(
                    as_optional_string(first(row, &["runUrl", "run_url"])).as_deref(),
                ),
            })
        })
        .collect()
}

fn parse_baseline(body: &Map<String, Value>) -> Result<Option<BaselineRow>, String> {
    let Some(baseline) =
        first(body, &["rolloutBaseline", "rollout_baseline"]).and_then(Value::as_object)
    else {
        return Ok(None);
    };
    let id: String = text_of(baseline.get("id"))
        .trim()
        .chars()
        .take(128)
        .collect();
    if id.is_empty() {
        return Err("rolloutBaseline.id is required".to_string());
    }
    let payload = baseline
        .get("payload")
        .and_then(Value::as_object)
        .ok_or_else(|| "rolloutBaseline.payload is required".to_string())?;
    let window_start = as_iso(first(baseline, &["windowStart", "window_start"]))?;
    let window_end = as_iso(first(baseline, &["windowEnd", "window_end"]))?;
    let source = source_of(baseline.get("source"));
    let baseline_hash: String = text_of(first(baseline, &["hash", "baseline_hash"]))
        .trim()
        .chars()
        .take(128)
        .collect();
    if baseline_hash.is_empty() {
        return Err("rolloutBaseline.hash is required".to_string());
    }
    Ok(Some(BaselineRow {
        input: BaselineInput {
            id,
            window_start,
            window_end,
            payload: Value::Object(payload.clone()),
            source,
            baseline_hash,
        },
    }))
}

fn parse_gate_run(body: &Map<String, Value>, now: &str) -> Result<Option<GateRunInput>, String> {
    let Some(row) = first(body, &["rolloutGateRun", "rollout_gate_run"]).and_then(Value::as_object)
    else {
        return Ok(None);
    };
    let status = match text_of(row.get("status")).trim().to_lowercase().as_str() {
        "pass" => GateStatus::Pass,
        "fail" => GateStatus::Fail,
        "unknown" => GateStatus::Unknown,
        _ => return Err("rolloutGateRun.status must be pass|fail|unknown".to_string()),
    };
    let payload = row
        .get("payload")
        .and_then(Value::as_object)
        .ok_or_else(|| "rolloutGateRun.payload is required".to_string())?;
    Ok(Some(GateRunInput {
        phase_id: as_optional_string(first(row, &["phaseId", "phase_id"])),
        status,
        payload: Value::Object(payload.clone()),
        generated_at: as_iso(Some(
            first(row, &["generatedAt", "generated_at"]).unwrap_or(&Value::String(now.to_string())),
        ))?,
    }))
}

/// `consumeRateQuota`: at most 12 accepted requests in any 60 seconds.
fn consume_rate_quota(window: &std::sync::Mutex<Vec<i64>>, now_ms: i64) -> bool {
    let mut bucket = window.lock().unwrap_or_else(|poison| poison.into_inner());
    bucket.retain(|stamp| now_ms - stamp <= RATE_WINDOW_MS);
    if bucket.len() >= MAX_REQUESTS_PER_WINDOW {
        return false;
    }
    bucket.push(now_ms);
    true
}

fn ingest_error(status: StatusCode, message: impl Into<String>) -> Response {
    error_json(status, message)
}

/// `POST /api/internal/stats/engineering/snapshots`
async fn engineering_snapshots(
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let ingest = &services.ingest;
    if !ingest.enabled {
        return ingest_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Engineering ingest is disabled by feature flag.",
        );
    }

    let provided = headers
        .get("x-engineering-ingest-token")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .unwrap_or("");
    let authorized = !ingest.token.is_empty()
        && !provided.is_empty()
        && ingest.token.len() == provided.len()
        && bool::from(ingest.token.as_bytes().ct_eq(provided.as_bytes()));
    if !authorized {
        return ingest_error(StatusCode::UNAUTHORIZED, "Unauthorized");
    }

    let now = Utc::now();
    let now_ms = now.timestamp_millis();
    let timestamp_ok = headers
        .get("x-engineering-ingest-timestamp")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|raw| !raw.is_empty())
        .and_then(|raw| DateTime::parse_from_rfc3339(raw).ok())
        .is_some_and(|parsed| (now_ms - parsed.timestamp_millis()).abs() <= MAX_CLOCK_SKEW_MS);
    if !timestamp_ok {
        return ingest_error(
            StatusCode::BAD_REQUEST,
            "Ingest timestamp is missing or outside allowed clock skew.",
        );
    }

    if !consume_rate_quota(&ingest.rate_window, now_ms) {
        return ingest_error(
            StatusCode::TOO_MANY_REQUESTS,
            "Rate limit exceeded for ingest window.",
        );
    }

    let idempotency_key: String = headers
        .get("x-engineering-ingest-idempotency-key")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .unwrap_or("")
        .chars()
        .take(128)
        .collect();
    if idempotency_key.is_empty() {
        return ingest_error(StatusCode::BAD_REQUEST, "Missing idempotency key.");
    }

    let store = services.engineering.lock().await;
    match store.has_ingest_receipt(&idempotency_key) {
        Ok(true) => {
            return ingest_error(StatusCode::CONFLICT, "Duplicate ingest idempotency key.");
        }
        Ok(false) => {}
        Err(error) => return ingest_error(StatusCode::BAD_REQUEST, error.to_string()),
    }

    let parsed: Value = match serde_json::from_slice(&body) {
        Ok(value) => value,
        Err(error) => return ingest_error(StatusCode::BAD_REQUEST, error.to_string()),
    };
    let Some(fields) = parsed.as_object() else {
        return ingest_error(StatusCode::BAD_REQUEST, "Invalid ingest payload.");
    };

    let now_iso_text = now_iso();
    let parsed_body = (|| -> Result<IngestBody, String> {
        Ok(IngestBody {
            snapshots: parse_snapshots(fields, &now_iso_text)?,
            pr_facts: parse_pr_facts(fields)?,
            events: parse_events(fields)?,
            baseline: parse_baseline(fields)?,
            gate_run: parse_gate_run(fields, &now_iso_text)?,
        })
    })();
    let ingest_body = match parsed_body {
        Ok(ingest_body) => ingest_body,
        Err(message) => return ingest_error(StatusCode::BAD_REQUEST, message),
    };

    let received_at = iso_from_ms(now_ms);
    let stored = store_ingest(&store, &idempotency_key, &received_at, &ingest_body, now);
    let pruned_events = match stored {
        Ok(pruned) => pruned,
        Err(message) => {
            let status = if message.contains("Duplicate ingest idempotency key") {
                StatusCode::CONFLICT
            } else {
                StatusCode::BAD_REQUEST
            };
            return ingest_error(status, message);
        }
    };

    Json(json!({
        "ok": true,
        "receivedAt": received_at,
        "accepted": {
            "snapshots": ingest_body.snapshots.len(),
            "prFacts": ingest_body.pr_facts.len(),
            "events": ingest_body.events.len(),
            "rolloutBaseline": u8::from(ingest_body.baseline.is_some()),
            "rolloutGateRun": u8::from(ingest_body.gate_run.is_some()),
            "prunedEvents": pruned_events,
        },
    }))
    .into_response()
}

/// Writes one parsed ingest body in the TypeScript order. Returns the number of
/// pruned harness events.
fn store_ingest(
    store: &betaclaw_core::stats::engineering_snapshot_repository::EngineeringSnapshotRepository,
    idempotency_key: &str,
    received_at: &str,
    body: &IngestBody,
    now: DateTime<Utc>,
) -> Result<usize, String> {
    let storage = |error: betaclaw_core::stats::StatsError| error.to_string();
    store
        .create_ingest_receipt(idempotency_key, received_at)
        .map_err(storage)?;
    for snapshot in &body.snapshots {
        store
            .store_snapshot(
                snapshot.window_days,
                &snapshot.payload,
                &snapshot.source,
                &snapshot.generated_at,
            )
            .map_err(storage)?;
    }
    if !body.pr_facts.is_empty() {
        store.replace_pr_facts(&body.pr_facts).map_err(storage)?;
    }
    if !body.events.is_empty() {
        store
            .append_harness_run_events(&body.events)
            .map_err(storage)?;
    }
    if let Some(baseline) = &body.baseline {
        if store
            .rollout_baseline_by_id(&baseline.input.id)
            .map_err(storage)?
            .is_none()
        {
            store
                .store_rollout_baseline(&baseline.input)
                .map_err(storage)?;
        }
    }
    if let Some(gate_run) = &body.gate_run {
        store.store_rollout_gate_run(gate_run).map_err(storage)?;
    }
    let cutoff = iso_from_ms((now - Duration::days(HARNESS_RETENTION_DAYS)).timestamp_millis());
    store
        .prune_harness_run_events_before(&cutoff)
        .map_err(storage)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use axum::http::Method;
    use serde_json::json;

    use crate::families::ops_wire::test_support::{
        scratch, send, services_with_env, state_in, ScratchDir,
    };
    use crate::families::ops_wire::Services;

    const GRAPHITI_PATH: &str = "/api/internal/model-hub/graphiti/v1/chat/completions";
    const GRAPHITI_BEARER: (&str, &str) = ("authorization", "Bearer graphiti-secret");
    const GRAPHITI_BODY: &str = r#"{"messages":[{"role":"user","content":"hi"}]}"#;
    const INGEST_PATH: &str = "/api/internal/stats/engineering/snapshots";

    fn services(scratch: &ScratchDir, pins: &[(&str, &str)]) -> Arc<Services> {
        Arc::new(services_with_env(scratch, pins))
    }

    fn graphiti_services(scratch: &ScratchDir) -> Arc<Services> {
        services(scratch, &[("GRAPHITI_MODEL_HUB_TOKEN", "graphiti-secret")])
    }

    fn ingest_services(scratch: &ScratchDir) -> Arc<Services> {
        services(
            scratch,
            &[
                ("ENGINEERING_INGEST_ENABLED", "true"),
                ("ENGINEERING_INGEST_TOKEN", "ingest-secret"),
            ],
        )
    }

    #[tokio::test]
    async fn graphiti_without_a_configured_token_is_503() {
        let scratch = scratch();
        let state = state_in(&scratch);
        let services = services(&scratch, &[]);
        let (status, body) = send(
            &state,
            &services,
            Method::POST,
            GRAPHITI_PATH,
            &[],
            Some(GRAPHITI_BODY),
        )
        .await;
        assert_eq!(status, 503);
        assert_eq!(
            body["error"]["message"],
            "Graphiti Model-Hub adapter token is not configured."
        );
        assert_eq!(body["error"]["type"], "model_hub_gateway_error");
    }

    #[tokio::test]
    async fn graphiti_rejects_a_wrong_bearer_token() {
        let scratch = scratch();
        let state = state_in(&scratch);
        let services = graphiti_services(&scratch);
        let (status, body) = send(
            &state,
            &services,
            Method::POST,
            GRAPHITI_PATH,
            &[("authorization", "Bearer wrong")],
            Some(GRAPHITI_BODY),
        )
        .await;
        assert_eq!(status, 401);
        assert_eq!(body["error"]["message"], "Unauthorized.");
    }

    #[tokio::test]
    async fn graphiti_serves_only_the_chat_completions_path() {
        let scratch = scratch();
        let state = state_in(&scratch);
        let services = graphiti_services(&scratch);
        let (status, body) = send(
            &state,
            &services,
            Method::POST,
            "/api/internal/model-hub/graphiti/v1/embeddings",
            &[GRAPHITI_BEARER],
            Some(GRAPHITI_BODY),
        )
        .await;
        assert_eq!(status, 404);
        assert_eq!(
            body["error"]["message"],
            "Only the chat completions endpoint is available."
        );
    }

    #[tokio::test]
    async fn graphiti_accepts_the_path_without_the_v1_prefix() {
        let scratch = scratch();
        let state = state_in(&scratch);
        let services = graphiti_services(&scratch);
        let (status, _) = send(
            &state,
            &services,
            Method::POST,
            "/api/internal/model-hub/graphiti/chat/completions",
            &[GRAPHITI_BEARER],
            Some(GRAPHITI_BODY),
        )
        .await;
        // Past the path check, so the empty test pipeline answers, not a 404.
        assert_eq!(status, 503);
    }

    #[tokio::test]
    async fn graphiti_rejects_a_body_that_is_not_json() {
        let scratch = scratch();
        let state = state_in(&scratch);
        let services = graphiti_services(&scratch);
        let (status, body) = send(
            &state,
            &services,
            Method::POST,
            GRAPHITI_PATH,
            &[GRAPHITI_BEARER],
            Some("not json"),
        )
        .await;
        assert_eq!(status, 400);
        assert_eq!(body["error"]["message"], "Request body must be valid JSON.");
    }

    #[tokio::test]
    async fn graphiti_rejects_messages_without_a_system_user_or_assistant_entry() {
        let scratch = scratch();
        let state = state_in(&scratch);
        let services = graphiti_services(&scratch);
        let (status, body) = send(
            &state,
            &services,
            Method::POST,
            GRAPHITI_PATH,
            &[GRAPHITI_BEARER],
            Some(r#"{"messages":[{"role":"tool","content":"x"}]}"#),
        )
        .await;
        assert_eq!(status, 400);
        assert_eq!(body["error"]["message"], "messages must not be empty.");
    }

    #[tokio::test]
    async fn graphiti_without_an_active_pipeline_is_503() {
        let scratch = scratch();
        let state = state_in(&scratch);
        let services = graphiti_services(&scratch);
        let (status, body) = send(
            &state,
            &services,
            Method::POST,
            GRAPHITI_PATH,
            &[GRAPHITI_BEARER],
            Some(GRAPHITI_BODY),
        )
        .await;
        assert_eq!(status, 503);
        assert_eq!(
            body["error"]["message"],
            "No active Graphiti JSON model is configured in Model Hub profile p1-graphiti."
        );
    }

    #[tokio::test]
    async fn ingest_is_off_without_the_feature_flag() {
        let scratch = scratch();
        let state = state_in(&scratch);
        let services = services(&scratch, &[]);
        let (status, body) = send(
            &state,
            &services,
            Method::POST,
            INGEST_PATH,
            &[],
            Some("{}"),
        )
        .await;
        assert_eq!(status, 503);
        assert_eq!(
            body,
            json!({ "ok": false, "error": "Engineering ingest is disabled by feature flag." })
        );
    }

    #[tokio::test]
    async fn ingest_rejects_a_missing_or_wrong_token() {
        let scratch = scratch();
        let state = state_in(&scratch);
        let services = ingest_services(&scratch);
        let now = chrono::Utc::now().to_rfc3339();
        let no_token = [("x-engineering-ingest-timestamp", now.as_str())];
        let wrong_token = [
            ("x-engineering-ingest-token", "nope"),
            ("x-engineering-ingest-timestamp", now.as_str()),
        ];
        for headers in [&no_token[..], &wrong_token[..]] {
            let (status, body) = send(
                &state,
                &services,
                Method::POST,
                INGEST_PATH,
                headers,
                Some("{}"),
            )
            .await;
            assert_eq!(status, 401);
            assert_eq!(body, json!({ "ok": false, "error": "Unauthorized" }));
        }
    }

    #[tokio::test]
    async fn ingest_rejects_a_timestamp_outside_the_clock_skew() {
        let scratch = scratch();
        let state = state_in(&scratch);
        let services = ingest_services(&scratch);
        let headers = [
            ("x-engineering-ingest-token", "ingest-secret"),
            ("x-engineering-ingest-timestamp", "2020-01-01T00:00:00.000Z"),
            ("x-engineering-ingest-idempotency-key", "key-stale"),
        ];
        let (status, body) = send(
            &state,
            &services,
            Method::POST,
            INGEST_PATH,
            &headers,
            Some("{}"),
        )
        .await;
        assert_eq!(status, 400);
        assert_eq!(
            body,
            json!({
                "ok": false,
                "error": "Ingest timestamp is missing or outside allowed clock skew.",
            })
        );
    }

    #[tokio::test]
    async fn ingest_needs_an_idempotency_key() {
        let scratch = scratch();
        let state = state_in(&scratch);
        let services = ingest_services(&scratch);
        let now = chrono::Utc::now().to_rfc3339();
        let headers = [
            ("x-engineering-ingest-token", "ingest-secret"),
            ("x-engineering-ingest-timestamp", now.as_str()),
        ];
        let (status, body) = send(
            &state,
            &services,
            Method::POST,
            INGEST_PATH,
            &headers,
            Some("{}"),
        )
        .await;
        assert_eq!(status, 400);
        assert_eq!(
            body,
            json!({ "ok": false, "error": "Missing idempotency key." })
        );
    }

    #[tokio::test]
    async fn ingest_stores_a_snapshot_once_per_idempotency_key() {
        let scratch = scratch();
        let state = state_in(&scratch);
        let services = ingest_services(&scratch);
        let now = chrono::Utc::now().to_rfc3339();
        let body = json!({
            "snapshots": [{ "windowDays": 7, "generatedAt": now, "source": "github-snapshot" }],
        })
        .to_string();
        let headers = [
            ("x-engineering-ingest-token", "ingest-secret"),
            ("x-engineering-ingest-timestamp", now.as_str()),
            ("x-engineering-ingest-idempotency-key", "key-1"),
        ];

        let (status, response) = send(
            &state,
            &services,
            Method::POST,
            INGEST_PATH,
            &headers,
            Some(body.as_str()),
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(response["ok"], true);
        assert!(response["receivedAt"].is_string());
        assert_eq!(response["accepted"]["snapshots"], 1);
        assert_eq!(response["accepted"]["prFacts"], 0);
        assert_eq!(response["accepted"]["rolloutBaseline"], 0);
        assert_eq!(response["accepted"]["prunedEvents"], 0);

        let (status, response) = send(
            &state,
            &services,
            Method::POST,
            INGEST_PATH,
            &headers,
            Some(body.as_str()),
        )
        .await;
        assert_eq!(status, 409);
        assert_eq!(
            response,
            json!({ "ok": false, "error": "Duplicate ingest idempotency key." })
        );
    }

    #[tokio::test]
    async fn ingest_accepts_only_seven_or_thirty_day_windows() {
        let scratch = scratch();
        let state = state_in(&scratch);
        let services = ingest_services(&scratch);
        let now = chrono::Utc::now().to_rfc3339();
        let headers = [
            ("x-engineering-ingest-token", "ingest-secret"),
            ("x-engineering-ingest-timestamp", now.as_str()),
            ("x-engineering-ingest-idempotency-key", "key-window"),
        ];
        let (status, response) = send(
            &state,
            &services,
            Method::POST,
            INGEST_PATH,
            &headers,
            Some(r#"{"snapshots":[{"windowDays":5}]}"#),
        )
        .await;
        assert_eq!(status, 400);
        assert_eq!(
            response,
            json!({ "ok": false, "error": "windowDays must be 7 or 30" })
        );
    }

    #[tokio::test]
    async fn ingest_is_rate_limited_to_twelve_requests_a_minute() {
        let scratch = scratch();
        let state = state_in(&scratch);
        let services = ingest_services(&scratch);
        let now = chrono::Utc::now().to_rfc3339();
        for index in 0..=12 {
            let key = format!("rate-{index}");
            let headers = [
                ("x-engineering-ingest-token", "ingest-secret"),
                ("x-engineering-ingest-timestamp", now.as_str()),
                ("x-engineering-ingest-idempotency-key", key.as_str()),
            ];
            let (status, response) = send(
                &state,
                &services,
                Method::POST,
                INGEST_PATH,
                &headers,
                Some("{}"),
            )
            .await;
            if index < 12 {
                assert_eq!(status, 200, "request {index}");
            } else {
                assert_eq!(status, 429);
                assert_eq!(
                    response,
                    json!({ "ok": false, "error": "Rate limit exceeded for ingest window." })
                );
            }
        }
    }
}
