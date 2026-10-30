//! Port of `src/core/memory/index.ts:1-78` — the core memory function-call
//! bridge and the memory preview.
//!
//! | TypeScript                                | Rust |
//! | ----------------------------------------- | ---- |
//! | `index.ts:18-52` (`handleCoreMemoryCall`) | [`handle_core_memory_call`] |
//! | `index.ts:54-78` (`getMemoryPreview`)     | [`get_memory_preview`] |
//!
//! Both functions talk to the `/api/memory` route of the same deployment. The
//! TypeScript uses the browser `fetch` with a relative URL; the Rust port takes
//! the base URL and an injected [`HttpTransport`], because `betaclaw-core` owns
//! no HTTP client (the gateway supplies both). The transport seam is the same
//! one the Model Hub adapters use (`model_hub/http.rs:235`).
//!
//! # Deviations
//!
//! 1. **The relative URL gets a base.** `fetch('/api/memory')` resolves against
//!    the page origin in a browser; here the caller passes the origin.
//! 2. **The warnings go to `tracing`.** `console.warn` becomes
//!    `tracing::warn!`; the message text is unchanged.
//! 3. **`args` spread.** `{ ...args, personaId }` also accepts an array in
//!    JavaScript (its indices become keys). The port reproduces that for objects
//!    and arrays and falls back to `{ personaId }` for every other (falsy or
//!    non-object) value, exactly like `args && typeof args === 'object'`.

use serde_json::{json, Map, Value};

use crate::memory::types::MemoryNode;
use crate::model_hub::http::{HttpRequest, HttpTransport};

/// `fcName` of the store tool — `index.ts:23`.
pub const CORE_MEMORY_STORE: &str = "core_memory_store";
/// `fcName` of the recall tool — `index.ts:23`.
pub const CORE_MEMORY_RECALL: &str = "core_memory_recall";

/// `handleCoreMemoryCall`'s non-null result — `index.ts:22`.
#[derive(Debug, Clone, PartialEq)]
pub struct CoreMemoryCallResult {
    /// `action: 'store' | 'recall'`.
    pub action: String,
    /// `data: unknown`.
    pub data: Value,
}

/// `handleCoreMemoryCall` from `index.ts:18-52`.
///
/// Returns `None` for every failure branch the TypeScript handles with a
/// `console.warn` + `null`: an unknown function name, a missing persona id, a
/// non-2xx answer, `ok !== true`, a missing `result`, a malformed JSON body or a
/// transport error.
pub async fn handle_core_memory_call(
    transport: &dyn HttpTransport,
    base_url: &str,
    fc_name: &str,
    args: Option<&Value>,
    persona_id: Option<&str>,
) -> Option<CoreMemoryCallResult> {
    if fc_name != CORE_MEMORY_STORE && fc_name != CORE_MEMORY_RECALL {
        return None;
    }
    let persona_id = match persona_id {
        Some(value) if !value.is_empty() => value,
        _ => {
            tracing::warn!("Memory call skipped: personaId is required.");
            return None;
        }
    };

    let payload_args = spread_args_with_persona_id(args, persona_id);

    let request = HttpRequest::post(join_url(base_url, "/api/memory"))
        .header("Content-Type", "application/json")
        .json_body(&json!({ "fcName": fc_name, "args": payload_args }));

    let response = match transport.send(request).await {
        Ok(response) => response,
        Err(error) => {
            tracing::warn!("Memory call request failed: {error}");
            return None;
        }
    };

    let payload: Value = match serde_json::from_str(&response.body) {
        Ok(payload) => payload,
        Err(error) => {
            tracing::warn!("Memory call request failed: {error}");
            return None;
        }
    };

    // `!response.ok || !payload.ok || !payload.result`.
    let result = payload.get("result");
    if !response.is_ok() || payload.get("ok") != Some(&Value::Bool(true)) || !is_truthy(result) {
        let detail = payload
            .get("error")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| format!("HTTP {}", response.status.as_u16()));
        tracing::warn!("Memory call failed: {detail}");
        return None;
    }

    let result = result.expect("checked above");
    Some(CoreMemoryCallResult {
        action: result
            .get("action")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        data: result.get("data").cloned().unwrap_or(Value::Null),
    })
}

/// `getMemoryPreview` from `index.ts:54-78`.
///
/// An absent persona id returns an empty list without a request, and every
/// failure branch (non-2xx, `ok !== true`, a non-array `nodes`, a malformed body
/// or a transport error) also returns an empty list.
pub async fn get_memory_preview(
    transport: &dyn HttpTransport,
    base_url: &str,
    persona_id: Option<&str>,
    limit: Option<f64>,
) -> Vec<MemoryNode> {
    let persona_id = match persona_id {
        Some(value) if !value.is_empty() => value,
        _ => return Vec::new(),
    };

    let safe_limit = clamp_limit(limit);
    let url = format!(
        "{}?personaId={}&preview=1&limit={}",
        join_url(base_url, "/api/memory"),
        encode_uri_component(persona_id),
        safe_limit
    );

    let response = match transport.send(HttpRequest::get(url)).await {
        Ok(response) => response,
        Err(error) => {
            tracing::warn!("Memory preview request failed: {error}");
            return Vec::new();
        }
    };

    let payload: Value = match serde_json::from_str(&response.body) {
        Ok(payload) => payload,
        Err(error) => {
            tracing::warn!("Memory preview failed: {error}");
            return Vec::new();
        }
    };

    let nodes = payload.get("nodes");
    if !response.is_ok()
        || payload.get("ok") != Some(&Value::Bool(true))
        || !nodes.is_some_and(Value::is_array)
    {
        let detail = payload
            .get("error")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| format!("HTTP {}", response.status.as_u16()));
        tracing::warn!("Memory preview failed: {detail}");
        return Vec::new();
    }

    serde_json::from_value(nodes.cloned().unwrap_or(Value::Array(Vec::new()))).unwrap_or_default()
}

/// `{ ...(args as Record<string, unknown>), personaId }` — `index.ts:29-32`.
fn spread_args_with_persona_id(args: Option<&Value>, persona_id: &str) -> Value {
    let mut map: Map<String, Value> = Map::new();
    match args {
        Some(Value::Object(entries)) => {
            map = entries.clone();
        }
        Some(Value::Array(entries)) => {
            for (index, entry) in entries.iter().enumerate() {
                map.insert(index.to_string(), entry.clone());
            }
        }
        _ => {}
    }
    map.insert("personaId".to_string(), json!(persona_id));
    Value::Object(map)
}

/// `Math.max(1, Math.min(200, Math.floor(Number.isFinite(limit) ? limit : 50)))`
/// — `index.ts:62`.
fn clamp_limit(limit: Option<f64>) -> i64 {
    let value = match limit {
        Some(value) if value.is_finite() => value,
        _ => 50.0,
    };
    (value.floor() as i64).clamp(1, 200)
}

/// JS truthiness for the `result` presence check.
fn is_truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|value| value != 0.0),
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Array(_)) | Some(Value::Object(_)) => true,
    }
}

/// `baseUrl.replace(/\/+$/, '') + path`, without turning an empty base into a
/// path with a leading double slash.
fn join_url(base_url: &str, path: &str) -> String {
    let trimmed = base_url.trim_end_matches('/');
    format!("{trimmed}{path}")
}

/// `encodeURIComponent(value)` — `index.ts:65`.
///
/// Every character except `A-Z a-z 0-9 - _ . ! ~ * ' ( )` is percent-encoded
/// from its UTF-8 bytes with uppercase hex digits.
fn encode_uri_component(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        let is_unreserved = byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            );
        if is_unreserved {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::{Arc, Mutex};

    use http::{Method, StatusCode};
    use serde_json::json;

    use super::*;
    use crate::model_hub::http::{BoxFuture, HttpError, HttpResponse};

    /// Records the requests and serves canned responses in order.
    struct StubTransport {
        requests: Mutex<Vec<HttpRequest>>,
        responses: Mutex<VecDeque<Result<HttpResponse, HttpError>>>,
    }

    impl StubTransport {
        fn new(responses: Vec<Result<HttpResponse, HttpError>>) -> Arc<Self> {
            Arc::new(Self {
                requests: Mutex::new(Vec::new()),
                responses: Mutex::new(responses.into()),
            })
        }
    }

    impl HttpTransport for StubTransport {
        fn send<'a>(
            &'a self,
            request: HttpRequest,
        ) -> BoxFuture<'a, Result<HttpResponse, HttpError>> {
            self.requests.lock().expect("lock").push(request);
            let response = self
                .responses
                .lock()
                .expect("lock")
                .pop_front()
                .expect("a canned response");
            Box::pin(async move { response })
        }
    }

    fn json_response(status: u16, value: Value) -> HttpResponse {
        HttpResponse::json(StatusCode::from_u16(status).expect("status"), &value)
    }

    #[tokio::test]
    async fn unknown_function_name_returns_none_without_a_request() {
        let transport = StubTransport::new(vec![]);
        let outcome = handle_core_memory_call(
            transport.as_ref(),
            "http://localhost",
            "other",
            Some(&json!({})),
            Some("persona-a"),
        )
        .await;
        assert_eq!(outcome, None);
        assert!(transport.requests.lock().expect("lock").is_empty());
    }

    #[tokio::test]
    async fn missing_persona_id_returns_none_without_a_request() {
        for persona in [None, Some("")] {
            let transport = StubTransport::new(vec![]);
            let outcome = handle_core_memory_call(
                transport.as_ref(),
                "http://localhost",
                CORE_MEMORY_STORE,
                Some(&json!({})),
                persona,
            )
            .await;
            assert_eq!(outcome, None);
            assert!(transport.requests.lock().expect("lock").is_empty());
        }
    }

    #[tokio::test]
    async fn store_call_posts_the_merged_arguments() {
        let transport = StubTransport::new(vec![Ok(json_response(
            200,
            json!({ "ok": true, "result": { "action": "store", "data": { "id": "n1" } } }),
        ))]);
        let outcome = handle_core_memory_call(
            transport.as_ref(),
            "http://localhost:3000",
            CORE_MEMORY_STORE,
            Some(&json!({ "type": "fact", "content": "coffee" })),
            Some("persona-a"),
        )
        .await
        .expect("result");
        assert_eq!(outcome.action, "store");
        assert_eq!(outcome.data, json!({ "id": "n1" }));

        let requests = transport.requests.lock().expect("lock");
        assert_eq!(requests[0].method, Method::POST);
        assert_eq!(requests[0].url, "http://localhost:3000/api/memory");
        let body: Value =
            serde_json::from_str(requests[0].body.as_deref().expect("body")).expect("json");
        assert_eq!(body["fcName"], json!("core_memory_store"));
        assert_eq!(body["args"]["personaId"], json!("persona-a"));
        assert_eq!(body["args"]["type"], json!("fact"));
    }

    #[tokio::test]
    async fn a_failed_response_returns_none() {
        let transport = StubTransport::new(vec![Ok(json_response(500, json!({ "ok": false })))]);
        let outcome = handle_core_memory_call(
            transport.as_ref(),
            "http://localhost",
            CORE_MEMORY_RECALL,
            Some(&json!({ "query": "x" })),
            Some("persona-a"),
        )
        .await;
        assert_eq!(outcome, None);
    }

    #[tokio::test]
    async fn a_falsy_result_returns_none() {
        let transport = StubTransport::new(vec![Ok(json_response(
            200,
            json!({ "ok": true, "result": null }),
        ))]);
        let outcome = handle_core_memory_call(
            transport.as_ref(),
            "http://localhost",
            CORE_MEMORY_RECALL,
            None,
            Some("persona-a"),
        )
        .await;
        assert_eq!(outcome, None);
    }

    #[tokio::test]
    async fn preview_without_a_persona_returns_empty_without_a_request() {
        let transport = StubTransport::new(vec![]);
        let nodes = get_memory_preview(transport.as_ref(), "http://localhost", None, None).await;
        assert!(nodes.is_empty());
        assert!(transport.requests.lock().expect("lock").is_empty());
    }

    #[tokio::test]
    async fn preview_encodes_the_persona_and_clamps_the_limit() {
        let transport = StubTransport::new(vec![Ok(json_response(
            200,
            json!({ "ok": true, "nodes": [] }),
        ))]);
        let nodes: Vec<MemoryNode> = get_memory_preview(
            transport.as_ref(),
            "http://localhost:3000/",
            Some("persona a/b"),
            Some(1000.7),
        )
        .await;
        assert!(nodes.is_empty());
        let requests = transport.requests.lock().expect("lock");
        assert_eq!(
            requests[0].url,
            "http://localhost:3000/api/memory?personaId=persona%20a%2Fb&preview=1&limit=200"
        );
    }

    #[tokio::test]
    async fn preview_without_a_numeric_limit_uses_fifty() {
        let transport = StubTransport::new(vec![Ok(json_response(
            200,
            json!({ "ok": true, "nodes": [] }),
        ))]);
        let _ = get_memory_preview(
            transport.as_ref(),
            "http://localhost",
            Some("p"),
            Some(f64::NAN),
        )
        .await;
        let requests = transport.requests.lock().expect("lock");
        assert!(requests[0].url.ends_with("limit=50"));
    }

    #[test]
    fn encode_uri_component_matches_the_javascript_builtin() {
        assert_eq!(
            encode_uri_component("abcXYZ019-_.!~*'()"),
            "abcXYZ019-_.!~*'()"
        );
        assert_eq!(encode_uri_component("a b"), "a%20b");
        assert_eq!(encode_uri_component("ä"), "%C3%A4");
        assert_eq!(encode_uri_component("a/b?c=d&e"), "a%2Fb%3Fc%3Dd%26e");
    }
}
