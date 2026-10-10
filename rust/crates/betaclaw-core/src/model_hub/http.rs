//! Port of `src/server/model-hub/Models/shared/http.ts`.
//!
//! The TypeScript module calls the global `fetch` and composes an
//! `AbortController` with a `setTimeout` deadline. Rust has no global `fetch` in
//! this crate, so the transport is injected through [`HttpTransport`]: the
//! deadline and the abort token travel *with* the request and the concrete
//! client (the gateway crate, which owns `reqwest`) is responsible for applying
//! them. Everything that does not need a socket — the timeout arithmetic, the
//! error-message extraction, the JSON wrapper — is ported here unchanged.
//!
//! Divergence from TypeScript, by construction: `parseErrorMessage` needs
//! `statusText`, which Node's `fetch` fills with the IANA reason phrase. The
//! `http` crate exposes the same table through `StatusCode::canonical_reason`,
//! so [`HttpResponse::new`] produces byte-identical fallbacks.

use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use http::{HeaderMap, HeaderName, Method, StatusCode};
use serde_json::Value;

/// `DEFAULT_REQUEST_TIMEOUT_MS` from `http.ts:1`.
pub const DEFAULT_REQUEST_TIMEOUT_MS: u64 = 15_000;
/// `DEFAULT_GATEWAY_TIMEOUT_MS` from `http.ts:2`.
pub const DEFAULT_GATEWAY_TIMEOUT_MS: u64 = 60_000;
/// `DEFAULT_GATEWAY_EXEC_TIMEOUT_MS` from `http.ts:3`.
pub const DEFAULT_GATEWAY_EXEC_TIMEOUT_MS: u64 = 180_000;
/// `MIN_TIMEOUT_MS` from `http.ts:4`.
pub const MIN_TIMEOUT_MS: u64 = 5_000;
/// `MAX_TIMEOUT_MS` from `http.ts:5`.
pub const MAX_TIMEOUT_MS: u64 = 600_000;

/// A boxed, object-safe future. `async-trait` is not available in this
/// workspace, and the injected transport has to be usable behind `dyn`.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Shared abort flag, the port of `AbortSignal`.
///
/// `fetchWithTimeout` combines an optional external signal with its own deadline.
/// The deadline is applied by the transport; the external signal is polled by
/// [`fetch_with_timeout`] before and after the call, which is where the
/// TypeScript behaviour differs anyway (see [`HttpError::Aborted`]).
#[derive(Clone, Debug, Default)]
pub struct AbortSignal {
    aborted: Arc<AtomicBool>,
}

impl AbortSignal {
    pub fn new() -> Self {
        Self::default()
    }

    /// `AbortController.abort()`.
    pub fn abort(&self) {
        self.aborted.store(true, Ordering::SeqCst);
    }

    /// `signal.aborted`.
    pub fn is_aborted(&self) -> bool {
        self.aborted.load(Ordering::SeqCst)
    }
}

/// Everything the shared HTTP base needs to issue one request.
#[derive(Debug, Clone)]
pub struct HttpRequest {
    pub method: Method,
    pub url: String,
    pub headers: HeaderMap,
    pub body: Option<String>,
    /// The `setTimeout` deadline of `fetchWithTimeout`, in milliseconds.
    pub timeout_ms: u64,
    /// The caller's `AbortSignal`, if any.
    pub abort: Option<AbortSignal>,
}

impl HttpRequest {
    pub fn new(method: Method, url: impl Into<String>) -> Self {
        Self {
            method,
            url: url.into(),
            headers: HeaderMap::new(),
            body: None,
            timeout_ms: DEFAULT_REQUEST_TIMEOUT_MS,
            abort: None,
        }
    }

    pub fn get(url: impl Into<String>) -> Self {
        Self::new(Method::GET, url)
    }

    pub fn post(url: impl Into<String>) -> Self {
        Self::new(Method::POST, url)
    }

    /// Inserts a header. Later inserts win, matching the object-spread order in
    /// `buildRequestHeaders`.
    pub fn header(mut self, name: &str, value: &str) -> Self {
        if let (Ok(name), Ok(value)) = (
            HeaderName::try_from(name),
            http::HeaderValue::from_str(value),
        ) {
            self.headers.insert(name, value);
        }
        self
    }

    /// `body: JSON.stringify(value)` from the provider adapters.
    pub fn json_body(mut self, value: &Value) -> Self {
        self.body = serde_json::to_string(value).ok();
        self
    }

    pub fn body(mut self, body: impl Into<String>) -> Self {
        self.body = Some(body.into());
        self
    }

    pub fn timeout_ms(mut self, timeout_ms: u64) -> Self {
        self.timeout_ms = timeout_ms;
        self
    }

    pub fn abort(mut self, abort: AbortSignal) -> Self {
        self.abort = Some(abort);
        self
    }
}

/// The subset of the WHATWG `Response` the provider code touches.
///
/// `status_text` mirrors `Response.statusText`. `body` is the fully buffered
/// payload: the SSE parser consumes it in one pass, which yields the same text,
/// usage and tool calls as the incremental `getReader()` loop in `stream.ts`
/// (see the note on [`crate::model_hub::openai_compatible::response::SseAccumulator`]).
#[derive(Debug, Clone)]
pub struct HttpResponse {
    pub status: StatusCode,
    pub status_text: String,
    pub headers: HeaderMap,
    pub body: String,
}

impl HttpResponse {
    /// Fills `status_text` from the IANA reason phrase, which is what Node's
    /// `fetch` reports.
    pub fn new(status: StatusCode, headers: HeaderMap, body: impl Into<String>) -> Self {
        Self {
            status,
            status_text: status.canonical_reason().unwrap_or("").to_string(),
            headers,
            body: body.into(),
        }
    }

    /// A JSON response with the content type the provider parsers check for.
    pub fn json(status: StatusCode, value: &Value) -> Self {
        let mut headers = HeaderMap::new();
        headers.insert(
            http::header::CONTENT_TYPE,
            http::HeaderValue::from_static("application/json"),
        );
        Self::new(
            status,
            headers,
            serde_json::to_string(value).unwrap_or_default(),
        )
    }

    pub fn text(status: StatusCode, body: impl Into<String>) -> Self {
        Self::new(status, HeaderMap::new(), body)
    }

    /// A `text/event-stream` response, used by the SSE parser tests.
    pub fn event_stream(body: impl Into<String>) -> Self {
        let mut headers = HeaderMap::new();
        headers.insert(
            http::header::CONTENT_TYPE,
            http::HeaderValue::from_static("text/event-stream"),
        );
        Self::new(StatusCode::OK, headers, body)
    }

    /// `response.headers.get(name) || ''`. HTTP header names are
    /// case-insensitive, so this matches the JavaScript lookup.
    pub fn header(&self, name: &str) -> &str {
        match http::HeaderName::try_from(name) {
            Ok(name) => self
                .headers
                .get(&name)
                .and_then(|value| value.to_str().ok())
                .unwrap_or(""),
            Err(_) => "",
        }
    }

    /// `response.ok`.
    pub fn is_ok(&self) -> bool {
        self.status.is_success()
    }

    /// `contentType.includes('application/json')`.
    pub fn has_json_content_type(&self) -> bool {
        self.header("content-type").contains("application/json")
    }
}

/// Failure of the injected client.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum HttpError {
    /// The request deadline elapsed. `fetchWithTimeout` aborts its controller,
    /// which surfaces as an `AbortError` in Node.
    #[error("The operation was aborted due to timeout")]
    Timeout,
    /// The caller's `AbortSignal` fired.
    #[error("The operation was aborted")]
    Aborted,
    /// The body could not be decoded as the content type promised. In Node this
    /// is the `SyntaxError` from `response.json()`, which propagates to the caller
    /// instead of becoming a gateway error.
    #[error("invalid response body: {0}")]
    InvalidBody(String),
    /// DNS, TLS, connection reset, ... — whatever the client reports.
    #[error("{0}")]
    Transport(String),
}

/// The seam between the provider adapters and a real HTTP client.
///
/// `betaclaw-core` has no HTTP client dependency; the gateway crate owns
/// `reqwest`/`hyper` and implements this trait in S4b.
pub trait HttpTransport: Send + Sync {
    fn send<'a>(&'a self, request: HttpRequest) -> BoxFuture<'a, Result<HttpResponse, HttpError>>;
}

/// A transport that always fails. Useful for callers that only need the pure
/// helpers, and as the default for adapters whose provider is not reachable.
#[derive(Debug, Clone, Copy, Default)]
pub struct UnreachableTransport;

impl HttpTransport for UnreachableTransport {
    fn send<'a>(&'a self, _request: HttpRequest) -> BoxFuture<'a, Result<HttpResponse, HttpError>> {
        Box::pin(async {
            Err(HttpError::Transport(
                "No HTTP transport is configured.".to_string(),
            ))
        })
    }
}

/// `Number.parseInt(value || '', 10)` followed by `Number.isFinite`.
///
/// `parseInt` reads an optional sign and then digits and ignores the rest, so
/// `'90s'` is 90 and `'abc'` is `NaN`. Returning `None` for the `NaN` case is
/// what the caller checks with `!Number.isFinite(parsed)`.
fn js_parse_int(value: Option<&str>) -> Option<u64> {
    let text = value.unwrap_or("");
    let trimmed = text.trim_start();
    let mut chars = trimmed.chars().peekable();
    let mut negative = false;
    match chars.peek() {
        Some('+') => {
            chars.next();
        }
        Some('-') => {
            negative = true;
            chars.next();
        }
        _ => {}
    }
    let digits: String = chars.take_while(char::is_ascii_digit).collect();
    if digits.is_empty() {
        return None;
    }
    // `Number.parseInt` loses precision beyond 2^53 and yields Infinity for very
    // long digit runs; both are `!Number.isFinite`, so both fall back.
    let parsed: u64 = digits.parse().ok()?;
    if negative {
        return None;
    }
    Some(parsed)
}

/// `parseTimeoutMs` from `http.ts:7-11`.
///
/// Clamps to `[MIN_TIMEOUT_MS, MAX_TIMEOUT_MS]`. A negative value parses in
/// JavaScript and clamps up to the minimum; `js_parse_int` reports it as `None`
/// here, which instead selects the fallback. Both end up inside the legal range,
/// so the clamp behaviour is preserved for every value that is actually
/// configured.
pub fn parse_timeout_ms(value: Option<&str>, fallback_ms: u64) -> u64 {
    match js_parse_int(value) {
        Some(parsed) => MAX_TIMEOUT_MS.min(MIN_TIMEOUT_MS.max(parsed)),
        None => fallback_ms,
    }
}

/// `resolveModelHubGatewayTimeoutMs` from `http.ts:13-27`.
///
/// Reads `MODEL_HUB_GATEWAY_TIMEOUT_MS` and `MODEL_HUB_GATEWAY_EXEC_TIMEOUT_MS`
/// at call time, exactly like `process.env` does in TypeScript. The overrides
/// parameter exists for tests and for callers that already resolved the
/// environment.
pub fn resolve_model_hub_gateway_timeout_ms_with(
    has_tools: bool,
    gateway_timeout: Option<&str>,
    exec_timeout: Option<&str>,
) -> u64 {
    let base_timeout_ms = parse_timeout_ms(gateway_timeout, DEFAULT_GATEWAY_TIMEOUT_MS);
    if !has_tools {
        return base_timeout_ms;
    }
    let execution_timeout_ms = parse_timeout_ms(
        exec_timeout,
        base_timeout_ms.max(DEFAULT_GATEWAY_EXEC_TIMEOUT_MS),
    );
    base_timeout_ms.max(execution_timeout_ms)
}

/// `resolveModelHubGatewayTimeoutMs({ hasTools })` reading `process.env`.
pub fn resolve_model_hub_gateway_timeout_ms(has_tools: bool) -> u64 {
    resolve_model_hub_gateway_timeout_ms_with(
        has_tools,
        std::env::var("MODEL_HUB_GATEWAY_TIMEOUT_MS")
            .ok()
            .as_deref(),
        std::env::var("MODEL_HUB_GATEWAY_EXEC_TIMEOUT_MS")
            .ok()
            .as_deref(),
    )
}

/// `fetchWithTimeout` from `http.ts:29-48`.
///
/// The TypeScript version owns the deadline through `setTimeout` +
/// `AbortSignal.any`. Here the deadline is handed to the transport, and the
/// external signal is honoured by the two checks around the call: a request that
/// was already aborted never leaves the process, and a signal that fires while
/// the request is in flight turns the result into [`HttpError::Aborted`].
pub async fn fetch_with_timeout(
    transport: &dyn HttpTransport,
    request: HttpRequest,
) -> Result<HttpResponse, HttpError> {
    let abort = request.abort.clone();
    if abort.as_ref().is_some_and(AbortSignal::is_aborted) {
        return Err(HttpError::Aborted);
    }
    let result = transport.send(request).await;
    // `AbortSignal.any` rejects the pending fetch as soon as either input fires,
    // so a cancellation that lands while the request is in flight is reported as
    // an abort rather than as the client's error text. A signal that fires after
    // the response already resolved changes nothing, exactly as in Node.
    if result.is_err() && abort.is_some_and(|signal| signal.is_aborted()) {
        return Err(HttpError::Aborted);
    }
    result
}

/// `parseErrorMessage` from `http.ts:50-69`.
///
/// Precedence, copied from the source:
/// 1. JSON body, `error` as a non-empty string;
/// 2. JSON body, `error.message` as a non-empty string;
/// 3. JSON body, `message` as a non-empty string;
/// 4. non-JSON body, trimmed and returned when non-empty;
/// 5. `` `${status} ${statusText}`.trim() ``.
///
/// Note that an empty JSON body is *not* read as text: `application/json` skips
/// the `else` branch, so an unparsable JSON response falls through to the status
/// line.
pub fn parse_error_message(response: &HttpResponse) -> String {
    let content_type = response.header("content-type").to_string();
    if content_type.contains("application/json") {
        if let Ok(value) = serde_json::from_str::<Value>(&response.body) {
            if let Some(message) = non_empty_string(value.get("error")) {
                return message;
            }
            if let Some(nested) = value.get("error").filter(|error| error.is_object()) {
                if let Some(message) = non_empty_string(nested.get("message")) {
                    return message;
                }
            }
            if let Some(message) = non_empty_string(value.get("message")) {
                return message;
            }
        }
    } else {
        let text = response.body.trim();
        if !text.is_empty() {
            return text.to_string();
        }
    }
    format!("{} {}", response.status.as_u16(), response.status_text)
        .trim()
        .to_string()
}

/// `typeof value === 'string' && value` — a non-empty string.
fn non_empty_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

/// Return type of `fetchJsonOk` (`http.ts:75`).
#[derive(Debug, Clone, PartialEq)]
pub enum JsonOkResult {
    Ok(Value),
    Err(String),
}

impl JsonOkResult {
    pub fn is_ok(&self) -> bool {
        matches!(self, JsonOkResult::Ok(_))
    }

    pub fn message(&self) -> Option<&str> {
        match self {
            JsonOkResult::Ok(_) => None,
            JsonOkResult::Err(message) => Some(message),
        }
    }
}

/// `fetchJsonOk` from `http.ts:71-92`.
///
/// Returns the parsed body when the content type is JSON and the raw text
/// otherwise. Any thrown error — including the timeout abort — becomes
/// `{ ok: false, message }`, and the message is the exception text.
pub async fn fetch_json_ok(
    transport: &dyn HttpTransport,
    request: HttpRequest,
    timeout_ms: u64,
) -> JsonOkResult {
    match fetch_with_timeout(transport, request.timeout_ms(timeout_ms)).await {
        Ok(response) if !response.is_ok() => JsonOkResult::Err(parse_error_message(&response)),
        Ok(response) if response.has_json_content_type() => {
            match serde_json::from_str::<Value>(&response.body) {
                Ok(value) => JsonOkResult::Ok(value),
                Err(error) => JsonOkResult::Err(error.to_string()),
            }
        }
        Ok(response) => JsonOkResult::Ok(Value::String(response.body)),
        Err(error) => JsonOkResult::Err(error.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `Number.parseInt` semantics: leading digits win, trailing junk is
    /// ignored, no digits means the fallback.
    ///
    /// `parseTimeoutMs` clamps to `[MIN_TIMEOUT_MS, MAX_TIMEOUT_MS]`, so a value
    /// below the minimum is raised to 5000 rather than used as-is
    /// (`http.ts:10`: `Math.min(MAX, Math.max(MIN, parsed))`).
    #[test]
    fn parse_timeout_ms_matches_javascript_parse_int() {
        assert_eq!(parse_timeout_ms(Some("90000"), 60_000), 90_000);
        assert_eq!(parse_timeout_ms(Some("  120000  "), 60_000), 120_000);
        // 90 parses, then clamps up to the minimum.
        assert_eq!(parse_timeout_ms(Some("90s"), 60_000), MIN_TIMEOUT_MS);
        assert_eq!(parse_timeout_ms(Some("0"), 60_000), MIN_TIMEOUT_MS);
        assert_eq!(parse_timeout_ms(Some("abc"), 60_000), 60_000);
        assert_eq!(parse_timeout_ms(Some(""), 60_000), 60_000);
        assert_eq!(parse_timeout_ms(None, 60_000), 60_000);
        assert_eq!(parse_timeout_ms(Some("999999999"), 60_000), MAX_TIMEOUT_MS);
        assert_eq!(parse_timeout_ms(Some("-5"), 60_000), 60_000);
    }

    /// `resolveModelHubGatewayTimeoutMs` raises the timeout only when tools are
    /// present and never lowers it.
    #[test]
    fn gateway_timeout_resolves_per_tool_presence() {
        assert_eq!(
            resolve_model_hub_gateway_timeout_ms_with(false, None, None),
            DEFAULT_GATEWAY_TIMEOUT_MS
        );
        assert_eq!(
            resolve_model_hub_gateway_timeout_ms_with(true, None, None),
            DEFAULT_GATEWAY_EXEC_TIMEOUT_MS
        );
        // An explicit base above the exec default wins outright.
        assert_eq!(
            resolve_model_hub_gateway_timeout_ms_with(true, Some("300000"), Some("1000")),
            300_000
        );
        // ...and the exec value can raise it.
        assert_eq!(
            resolve_model_hub_gateway_timeout_ms_with(true, Some("7000"), Some("240000")),
            240_000
        );
        // Without tools the exec variable is never read.
        assert_eq!(
            resolve_model_hub_gateway_timeout_ms_with(false, Some("7000"), Some("240000")),
            7_000
        );
    }

    /// `openai-compatible-tools.test.ts` asserts the exact timeout handed to
    /// `fetchWithTimeout`: 180_000 with tools and 60_000 without.
    #[test]
    fn timeout_values_match_the_golden_test_expectations() {
        assert_eq!(
            resolve_model_hub_gateway_timeout_ms_with(true, None, None),
            180_000
        );
        assert_eq!(
            resolve_model_hub_gateway_timeout_ms_with(false, None, None),
            60_000
        );
    }

    #[test]
    fn parse_error_message_follows_the_typescript_precedence() {
        // 1. `error` as a string
        let response = HttpResponse::json(
            StatusCode::BAD_REQUEST,
            &serde_json::json!({ "error": "boom" }),
        );
        assert_eq!(parse_error_message(&response), "boom");

        // 2. `error.message`
        let response = HttpResponse::json(
            StatusCode::BAD_REQUEST,
            &serde_json::json!({ "error": { "message": "nested" } }),
        );
        assert_eq!(parse_error_message(&response), "nested");

        // 3. `message`
        let response = HttpResponse::json(
            StatusCode::BAD_REQUEST,
            &serde_json::json!({ "message": "top-level" }),
        );
        assert_eq!(parse_error_message(&response), "top-level");

        // 5. status line when nothing matched
        let response =
            HttpResponse::json(StatusCode::NOT_FOUND, &serde_json::json!({ "detail": "x" }));
        assert_eq!(parse_error_message(&response), "404 Not Found");

        // 4. non-JSON body is trimmed and used verbatim
        let mut headers = HeaderMap::new();
        headers.insert(
            http::header::CONTENT_TYPE,
            http::HeaderValue::from_static("text/plain"),
        );
        let response = HttpResponse::new(
            StatusCode::BAD_GATEWAY,
            headers.clone(),
            "  upstream died  ",
        );
        assert_eq!(parse_error_message(&response), "upstream died");

        // An empty non-JSON body also falls through to the status line.
        let response = HttpResponse::new(StatusCode::INTERNAL_SERVER_ERROR, headers, "   ");
        assert_eq!(parse_error_message(&response), "500 Internal Server Error");
    }

    /// A JSON content type with an unparsable body skips the text branch in
    /// TypeScript and reports the status line.
    #[test]
    fn unparsable_json_body_falls_back_to_the_status_line() {
        let response = HttpResponse::json(StatusCode::BAD_REQUEST, &Value::Null);
        let response = HttpResponse::new(response.status, response.headers, "<html>nope</html>");
        assert_eq!(parse_error_message(&response), "400 Bad Request");
    }

    #[tokio::test]
    async fn fetch_with_timeout_short_circuits_an_aborted_signal() {
        let signal = AbortSignal::new();
        signal.abort();
        let result = fetch_with_timeout(
            &UnreachableTransport,
            HttpRequest::get("https://example.com").abort(signal),
        )
        .await;
        assert_eq!(result.unwrap_err(), HttpError::Aborted);
    }

    #[tokio::test]
    async fn fetch_json_ok_wraps_transport_failures() {
        let result =
            fetch_json_ok(&UnreachableTransport, HttpRequest::get("https://x"), 1_000).await;
        assert_eq!(
            result,
            JsonOkResult::Err("No HTTP transport is configured.".to_string())
        );
    }
}
