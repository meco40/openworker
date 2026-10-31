//! Port of `src/server/skills/handlers/httpRequest.ts`.
//!
//! A generic HTTP client for API calls. The caller reads `BETACLAW_HTTP_SKILL_ENABLED` and
//! passes the result as `enabled`, so the handler never reads the environment. The request
//! goes through the SSRF guard with no redirects, as TypeScript sets `maxRedirects: 0`.
//!
//! Deviations:
//! - TypeScript sends `Content-Type: undefined` on requests without a body. `fetch` turns
//!   that into the literal value `undefined`. This port sends no such header.
//! - A `headers` argument that is not an object is ignored. TypeScript spreads a string into
//!   indexed header names, and the request then fails.

use http::header::{HeaderName, HeaderValue};
use http::Method;
use serde_json::{json, Map, Value};

use super::http_text::{js_slice_to, utf16_len};
use super::types::{arg_string, js_to_string, js_trim, SkillError};
use crate::model_hub::http::{HttpRequest, HttpTransport};
use crate::net_guard::ssrf_guard::{check_body_limit, fetch_with_ssrf_guard, Resolver};

const DISABLED_MESSAGE: &str =
    "http_request skill is disabled. Set BETACLAW_HTTP_SKILL_ENABLED=true in your environment to enable it.";
const HTTP_TIMEOUT_MS: u64 = 30_000;
/// `HTTP_BODY_MAX_CHARS`, counted in UTF-16 units.
const HTTP_BODY_MAX_CHARS: usize = 8_000;
const RESPONSE_BODY_LIMIT_BYTES: usize = 1_000_000;

/// `http_request`. `enabled` is `BETACLAW_HTTP_SKILL_ENABLED` equal to `"true"`, ignoring case.
pub async fn http_request(
    transport: &dyn HttpTransport,
    resolver: &dyn Resolver,
    args: &Map<String, Value>,
    enabled: bool,
) -> Result<Value, SkillError> {
    if !enabled {
        return Ok(json!({ "error": DISABLED_MESSAGE }));
    }

    let method_name = match arg_string(args, "method") {
        name if name.is_empty() => "GET".to_string(),
        name => name.to_uppercase(),
    };
    let url = js_trim(&arg_string(args, "url")).to_string();
    if url.is_empty() {
        return Ok(json!({ "error": "url is required" }));
    }
    let Some(method) = method_of(&method_name) else {
        return Ok(json!({
            "error": format!(
                "Unsupported HTTP method: {method_name}. Allowed: GET, POST, PUT, PATCH, DELETE, HEAD"
            )
        }));
    };

    // `JSON.stringify(args.body)` when the key is present, null included.
    let body = args
        .get("body")
        .map(|value| serde_json::to_string(value).unwrap_or_default());

    let mut request = HttpRequest::new(method.clone(), url).timeout_ms(HTTP_TIMEOUT_MS);
    if body.is_some() {
        request = request.header("Content-Type", "application/json");
    }
    request = request.header("User-Agent", "betaclaw-http-skill/1.0");
    if let Some(Value::Object(custom)) = args.get("headers") {
        // Custom headers come last, so they win over the defaults, as in the object spread.
        for (name, value) in custom {
            let Ok(header_name) = HeaderName::from_bytes(name.as_bytes()) else {
                return Ok(failed(&format!(
                    "Headers.append: \"{name}\" is an invalid header name."
                )));
            };
            let text = js_to_string(value);
            let Ok(header_value) = HeaderValue::from_str(&text) else {
                return Ok(failed(&format!(
                    "Headers.append: \"{text}\" is an invalid header value."
                )));
            };
            request.headers.insert(header_name, header_value);
        }
    }
    if method == Method::POST || method == Method::PUT || method == Method::PATCH {
        request.body = body;
    }

    let guarded = match fetch_with_ssrf_guard(transport, resolver, request, 0).await {
        Ok(guarded) => guarded,
        Err(error) => return Ok(failed(&error.to_string())),
    };
    if let Err(error) = check_body_limit(&guarded.response, RESPONSE_BODY_LIMIT_BYTES) {
        return Ok(failed(&error.to_string()));
    }

    let response = &guarded.response;
    let text = response.body.as_str();
    let body_value = if response.header("content-type").contains("application/json") {
        // A body that is not valid JSON is returned as text, as in TypeScript.
        serde_json::from_str::<Value>(text).unwrap_or_else(|_| Value::String(text.to_string()))
    } else if utf16_len(text) > HTTP_BODY_MAX_CHARS {
        Value::String(format!(
            "{}\u{2026}",
            js_slice_to(text, HTTP_BODY_MAX_CHARS as i64)
        ))
    } else {
        Value::String(text.to_string())
    };

    let mut headers = Map::new();
    for name in response.headers.keys() {
        // `Headers` joins repeated values with ", ".
        let joined = response
            .headers
            .get_all(name)
            .iter()
            .map(|value| String::from_utf8_lossy(value.as_bytes()).into_owned())
            .collect::<Vec<_>>()
            .join(", ");
        headers.insert(name.as_str().to_string(), Value::String(joined));
    }

    Ok(json!({
        "status": response.status.as_u16(),
        "statusText": response.status_text,
        "headers": headers,
        "body": body_value,
    }))
}

fn method_of(name: &str) -> Option<Method> {
    match name {
        "GET" => Some(Method::GET),
        "POST" => Some(Method::POST),
        "PUT" => Some(Method::PUT),
        "PATCH" => Some(Method::PATCH),
        "DELETE" => Some(Method::DELETE),
        "HEAD" => Some(Method::HEAD),
        _ => None,
    }
}

fn failed(message: &str) -> Value {
    json!({ "error": format!("HTTP request failed: {message}") })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net_guard::test_support::{response_with, FakeResolver, FakeTransport};

    fn resolver() -> FakeResolver {
        FakeResolver::with(vec![("example.test", vec!["93.184.216.34"])])
    }

    fn args(value: Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap_or_default()
    }

    #[tokio::test]
    async fn a_disabled_skill_answers_with_the_setup_hint() {
        let transport = FakeTransport::with(vec![]);
        let out = http_request(
            &transport,
            &resolver(),
            &args(json!({"url": "https://example.test/"})),
            false,
        )
        .await
        .expect("ok");
        assert_eq!(out["error"], DISABLED_MESSAGE);
        assert!(transport.requests().is_empty());
    }

    #[tokio::test]
    async fn bad_input_is_reported_before_anything_is_sent() {
        let transport = FakeTransport::with(vec![]);
        let out = http_request(&transport, &resolver(), &args(json!({})), true)
            .await
            .expect("ok");
        assert_eq!(out, json!({ "error": "url is required" }));
        let out = http_request(
            &transport,
            &resolver(),
            &args(json!({"url": "https://example.test/", "method": "trace"})),
            true,
        )
        .await
        .expect("ok");
        assert_eq!(
            out,
            json!({ "error": "Unsupported HTTP method: TRACE. Allowed: GET, POST, PUT, PATCH, DELETE, HEAD" })
        );
        assert!(transport.requests().is_empty());
    }

    #[tokio::test]
    async fn a_json_post_sends_the_body_and_custom_headers() {
        let transport = FakeTransport::with(vec![Ok(response_with(
            201,
            &[("content-type", "application/json")],
            r#"{"ok":true}"#,
        ))]);
        let out = http_request(
            &transport,
            &resolver(),
            &args(json!({
                "url": "https://example.test/api",
                "method": "post",
                "body": {"a": 1},
                "headers": {"X-Token": "t", "User-Agent": "custom"}
            })),
            true,
        )
        .await
        .expect("ok");
        assert_eq!(out["status"], 201);
        assert_eq!(out["body"], json!({"ok": true}));
        let sent = &transport.requests()[0];
        assert_eq!(sent.method, Method::POST);
        assert_eq!(sent.body.as_deref(), Some("{\"a\":1}"));
        assert_eq!(
            sent.headers.get("content-type").expect("content type"),
            "application/json"
        );
        assert_eq!(sent.headers.get("x-token").expect("token"), "t");
        assert_eq!(sent.headers.get("user-agent").expect("agent"), "custom");
    }

    #[tokio::test]
    async fn a_get_without_a_body_sends_neither_body_nor_content_type() {
        let transport = FakeTransport::with(vec![Ok(response_with(200, &[], "plain"))]);
        let out = http_request(
            &transport,
            &resolver(),
            &args(json!({"url": "https://example.test/", "body": {"x": 1}})),
            true,
        )
        .await
        .expect("ok");
        assert_eq!(out["body"], "plain");
        let sent = &transport.requests()[0];
        assert_eq!(sent.body, None, "GET never carries the body");
        assert!(
            sent.headers.contains_key("content-type"),
            "a body was given, so the header is set"
        );
    }

    #[tokio::test]
    async fn private_targets_and_redirects_are_refused() {
        let transport = FakeTransport::with(vec![]);
        let out = http_request(
            &transport,
            &resolver(),
            &args(json!({"url": "http://127.0.0.1/"})),
            true,
        )
        .await
        .expect("ok");
        assert_eq!(
            out,
            json!({ "error": "HTTP request failed: SSRF guard: blocked private/loopback address \"127.0.0.1\"" })
        );

        let transport =
            FakeTransport::with(vec![Ok(response_with(302, &[("location", "/next")], ""))]);
        let out = http_request(
            &transport,
            &resolver(),
            &args(json!({"url": "https://example.test/"})),
            true,
        )
        .await
        .expect("ok");
        assert_eq!(
            out,
            json!({ "error": "HTTP request failed: SSRF guard: redirect limit exceeded." })
        );
    }

    #[tokio::test]
    async fn an_invalid_header_name_fails_the_request_before_the_send() {
        let transport = FakeTransport::with(vec![]);
        let out = http_request(
            &transport,
            &resolver(),
            &args(json!({"url": "https://example.test/", "headers": {"bad name": "x"}})),
            true,
        )
        .await
        .expect("ok");
        assert_eq!(
            out,
            json!({ "error": "HTTP request failed: Headers.append: \"bad name\" is an invalid header name." })
        );
        assert!(transport.requests().is_empty());
    }

    #[tokio::test]
    async fn long_text_is_cut_to_the_body_limit_with_an_ellipsis() {
        let long = "a".repeat(9_000);
        let transport = FakeTransport::with(vec![Ok(response_with(
            200,
            &[("content-type", "text/plain")],
            &long,
        ))]);
        let out = http_request(
            &transport,
            &resolver(),
            &args(json!({"url": "https://example.test/"})),
            true,
        )
        .await
        .expect("ok");
        let body = out["body"].as_str().expect("text body");
        assert!(body.ends_with('\u{2026}'));
        assert_eq!(utf16_len(body), HTTP_BODY_MAX_CHARS + 1);
    }
}
