//! Port of `src/server/model-hub/Models/shared/openai-compatible/`.
//!
//! The shared layer is the leverage point of the whole S4a slice: once a provider
//! is expressible as a base URL plus a couple of strings, every additional
//! OpenAI-compatible provider is pure data. Sub-modules mirror the TypeScript
//! layout one to one:
//!
//! | Rust | TypeScript |
//! | --- | --- |
//! | [`constants`] | `constants.ts` |
//! | [`utils`] | `utils.ts` (+ `channels/messages/attachments.ts`) |
//! | [`request`] | `request/build.ts`, `request/headers.ts`, `request/stream.ts` |
//! | [`response`] | `response/parse.ts`, `response/error.ts`, `response/stream.ts` |
//! | [`models`] | `models/fetch.ts` |
//! | [`dispatch_openai_compatible_chat`] | `index.ts:51-97` |

pub mod constants;
pub mod models;
pub mod request;
pub mod response;
pub mod utils;

use std::sync::Arc;

use serde_json::Value;

use crate::model_hub::http::{
    fetch_with_timeout, AbortSignal, HttpError, HttpRequest, HttpTransport,
};
use crate::model_hub::types::{GatewayRequest, GatewayResponse};

pub use models::{fetch_openai_compatible_models, test_openai_compatible_models_endpoint};
pub use request::{
    build_openai_compatible_messages, build_request_body, build_request_body_with_attachments,
    build_request_headers, resolve_timeout_ms, resolve_timeout_ms_with, should_use_stream,
};
pub use response::{
    create_error_response, extract_sse_payloads, map_stream_usage, parse_chat_response,
    parse_error_response, parse_openai_compatible_sse_response, SseAccumulator, StreamParseResult,
};
pub use utils::{
    attachment_fallback_text, build_chat_url, build_models_url, build_optional_auth_headers,
    data_url_for_bytes, is_image_attachment, is_text_attachment, normalize_base_url,
    normalize_bearer_secret, read_stored_attachment_as_data_url, read_text_attachment_snippet,
    strip_thinking_blocks, AttachmentStore, NoopAttachmentStore, NOOP_ATTACHMENT_STORE,
};

use constants::CONTENT_TYPE_EVENT_STREAM;

/// `options.onStreamDelta`. Shared by [`DispatchOptions`] and
/// [`DispatchOptions::with_stream_delta`]; a function pointer has no `Debug`
/// implementation of its own, so the alias also keeps that derive hand-written.
pub type StreamDeltaCallback = Arc<dyn Fn(&str) + Send + Sync>;

/// `DispatchOptions` from `openai-compatible/types.ts:48-52`.
///
/// `Debug` is written by hand: a function pointer has no `Debug` implementation,
/// and the derived one would therefore make the whole struct unprintable. The
/// callback is reported as `Some(..)`/`None` only — it is never logged.
#[derive(Clone, Default)]
pub struct DispatchOptions {
    /// Merged into the headers after `Content-Type` and `Authorization`.
    pub extra_headers: Vec<(String, String)>,
    /// The caller's cancellation signal.
    pub abort: Option<AbortSignal>,
    /// `onStreamDelta`, called with every content delta while a stream is read.
    pub on_stream_delta: Option<StreamDeltaCallback>,
}

impl std::fmt::Debug for DispatchOptions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DispatchOptions")
            .field("extra_headers", &self.extra_headers)
            .field("abort", &self.abort)
            .field(
                "on_stream_delta",
                &self.on_stream_delta.as_ref().map(|_| ".."),
            )
            .finish()
    }
}

impl DispatchOptions {
    pub fn with_extra_headers(extra_headers: Vec<(String, String)>) -> Self {
        Self {
            extra_headers,
            ..Self::default()
        }
    }

    pub fn with_stream_delta(callback: StreamDeltaCallback) -> Self {
        Self {
            on_stream_delta: Some(callback),
            ..Self::default()
        }
    }
}

/// `dispatchOpenAICompatibleChat` from `index.ts:51-97`.
///
/// The only branch points are the timeout (`request.tools` decides between the
/// 60 s and 180 s defaults), the non-2xx error path, and the SSE path, which is
/// taken only when `request.stream === true` **and** the response content type
/// contains `text/event-stream`.
///
/// A transport failure or an undecodable body is returned as an `Err`, matching
/// TypeScript, where the rejected promise escapes `dispatchGatewayRequest`. An
/// HTTP error status is *not* an `Err` — it becomes a `GatewayResponse` with
/// `ok: false`.
pub async fn dispatch_openai_compatible_chat(
    transport: &dyn HttpTransport,
    attachments: &dyn AttachmentStore,
    base_url: &str,
    secret: &str,
    provider_id: &str,
    request: &GatewayRequest,
    options: &DispatchOptions,
) -> Result<GatewayResponse, HttpError> {
    let url = build_chat_url(base_url);
    let wants_stream = request.stream == Some(true);
    let timeout_ms = resolve_timeout_ms(has_tools(request));

    let body = build_request_body_with_attachments(attachments, request, provider_id);
    let headers = build_request_headers(secret, &options.extra_headers);

    let mut http_request = HttpRequest::post(url)
        .timeout_ms(timeout_ms)
        .json_body(&body);
    for (name, value) in &headers {
        http_request = http_request.header(name, value);
    }
    if let Some(abort) = options.abort.clone() {
        http_request = http_request.abort(abort);
    }

    let response = fetch_with_timeout(transport, http_request).await?;

    if !response.is_ok() {
        return Ok(parse_error_response(
            response.status.as_u16(),
            &response.body,
            &request.model,
            provider_id,
        ));
    }

    if wants_stream
        && response
            .header("content-type")
            .to_lowercase()
            .contains(CONTENT_TYPE_EVENT_STREAM)
    {
        let parsed = match options.on_stream_delta.clone() {
            Some(callback) => {
                let mut sink = move |delta: &str| callback(delta);
                parse_openai_compatible_sse_response(&response.body, Some(&mut sink))
            }
            None => parse_openai_compatible_sse_response(&response.body, None),
        };
        return Ok(GatewayResponse {
            ok: true,
            text: strip_thinking_blocks(&parsed.text),
            model: parsed.model.unwrap_or_else(|| request.model.clone()),
            provider: provider_id.to_string(),
            usage: parsed.usage,
            function_calls: parsed.function_calls,
            rate_limits: None,
            error: None,
        });
    }

    let json: Value = serde_json::from_str(&response.body)
        .map_err(|error| HttpError::InvalidBody(error.to_string()))?;
    Ok(parse_chat_response(&json, &request.model, provider_id))
}

/// `Array.isArray(request.tools) && request.tools.length > 0` from `index.ts:60`.
fn has_tools(request: &GatewayRequest) -> bool {
    request
        .tools
        .as_ref()
        .is_some_and(|tools| !tools.is_empty())
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use http::{HeaderMap, StatusCode};

    use super::*;
    use crate::model_hub::http::{BoxFuture, HttpResponse};
    use crate::model_hub::tests::StubAttachmentStore;
    use crate::model_hub::types::GatewayMessage;

    struct CapturingTransport {
        status: StatusCode,
        content_type: Option<&'static str>,
        body: String,
        seen: Mutex<Vec<HttpRequest>>,
    }

    impl CapturingTransport {
        fn ok_json(body: &str) -> Arc<Self> {
            Arc::new(Self {
                status: StatusCode::OK,
                content_type: Some("application/json"),
                body: body.to_string(),
                seen: Mutex::new(Vec::new()),
            })
        }

        fn sse(body: &str) -> Arc<Self> {
            Arc::new(Self {
                status: StatusCode::OK,
                content_type: Some("text/event-stream"),
                body: body.to_string(),
                seen: Mutex::new(Vec::new()),
            })
        }

        fn error(status: StatusCode, body: &str) -> Arc<Self> {
            Arc::new(Self {
                status,
                content_type: Some("application/json"),
                body: body.to_string(),
                seen: Mutex::new(Vec::new()),
            })
        }
    }

    impl HttpTransport for CapturingTransport {
        fn send<'a>(
            &'a self,
            request: HttpRequest,
        ) -> BoxFuture<'a, Result<HttpResponse, HttpError>> {
            self.seen.lock().expect("lock").push(request.clone());
            let mut headers = HeaderMap::new();
            if let Some(content_type) = self.content_type {
                headers.insert(
                    http::header::CONTENT_TYPE,
                    http::HeaderValue::from_static(content_type),
                );
            }
            let response = HttpResponse::new(self.status, headers, self.body.clone());
            Box::pin(async move { Ok(response) })
        }
    }

    fn user_request() -> GatewayRequest {
        GatewayRequest::new("gpt-4o-mini", vec![GatewayMessage::user("hello")])
    }

    /// The first golden case: 180_000 ms because tools are present.
    #[tokio::test]
    async fn tools_raise_the_timeout_to_180_seconds() {
        let transport = CapturingTransport::ok_json(
            r#"{"choices":[{"message":{"content":"ok"}}],"model":"gpt-4o-mini"}"#,
        );
        let mut request = user_request();
        request.tools = Some(vec![serde_json::json!({
            "type": "function",
            "function": { "name": "safe_files", "parameters": { "type": "object", "properties": {} } }
        })]);

        dispatch_openai_compatible_chat(
            &*transport,
            &StubAttachmentStore::default(),
            "https://api.example.com/v1",
            "sk-test",
            "openai",
            &request,
            &DispatchOptions::default(),
        )
        .await
        .expect("dispatch");

        let seen = transport.seen.lock().expect("lock");
        assert_eq!(seen[0].url, "https://api.example.com/v1/chat/completions");
        assert_eq!(seen[0].timeout_ms, 180_000);
        assert_eq!(
            seen[0].headers.get("content-type").expect("content type"),
            "application/json"
        );
        assert_eq!(
            seen[0].headers.get("authorization").expect("authorization"),
            "Bearer sk-test"
        );
        assert_eq!(
            seen[0].body.as_deref().expect("body"),
            r#"{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hello"}],"max_tokens":4096,"temperature":0.7,"stream":false,"tools":[{"type":"function","function":{"name":"safe_files","parameters":{"type":"object","properties":{}}}}]}"#
        );
    }

    /// Without tools the timeout is the 60 s default.
    #[tokio::test]
    async fn no_tools_use_the_sixty_second_timeout() {
        let transport =
            CapturingTransport::ok_json(r#"{"choices":[{"message":{"content":"ok"}}]}"#);
        dispatch_openai_compatible_chat(
            &*transport,
            &StubAttachmentStore::default(),
            "https://api.example.com/v1",
            "sk-test",
            "openai",
            &user_request(),
            &DispatchOptions::default(),
        )
        .await
        .expect("dispatch");
        assert_eq!(transport.seen.lock().expect("lock")[0].timeout_ms, 60_000);
    }

    /// A non-2xx status becomes a `GatewayResponse`, not an error.
    #[tokio::test]
    async fn http_errors_become_gateway_responses() {
        let transport =
            CapturingTransport::error(StatusCode::TOO_MANY_REQUESTS, r#"{"error":"slow down"}"#);
        let response = dispatch_openai_compatible_chat(
            &*transport,
            &StubAttachmentStore::default(),
            "https://api.example.com/v1",
            "sk-test",
            "openai",
            &user_request(),
            &DispatchOptions::default(),
        )
        .await
        .expect("no transport error");

        assert!(!response.ok);
        assert_eq!(response.error.as_deref(), Some("slow down"));
        assert_eq!(response.model, "gpt-4o-mini");
        assert_eq!(response.provider, "openai");
    }

    #[tokio::test]
    async fn streams_are_parsed_when_requested_and_announced() {
        let body = concat!(
            "data: {\"model\":\"m\",\"choices\":[{\"delta\":{\"content\":\"Hel\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"lo<think>x</think>\"}}]}\n\n",
            "data: [DONE]\n\n"
        );
        let transport = CapturingTransport::sse(body);
        let mut request = user_request();
        request.stream = Some(true);

        // `with_stream_delta` takes an `Fn`, so the accumulator needs interior
        // mutability rather than a captured `String`.
        let deltas = Arc::new(Mutex::new(String::new()));
        let sink_buffer = Arc::clone(&deltas);
        let sink: Arc<dyn Fn(&str) + Send + Sync> = Arc::new(move |delta: &str| {
            sink_buffer.lock().expect("lock").push_str(delta);
        });
        let options = DispatchOptions::with_stream_delta(sink);

        let response = dispatch_openai_compatible_chat(
            &*transport,
            &StubAttachmentStore::default(),
            "https://api.example.com/v1",
            "sk-test",
            "openai",
            &request,
            &options,
        )
        .await
        .expect("dispatch");

        assert!(response.ok);
        // `stripThinkingBlocks` runs on the streamed text, so the accumulated
        // text is shorter than the concatenation of the raw deltas.
        assert_eq!(response.text, "Hello");
        assert_eq!(response.model, "m");
        let (open, close) = crate::model_hub::tests::think_delimiters();
        assert_eq!(
            *deltas.lock().expect("lock"),
            // "Hel" plus the second delta, thinking block included.
            format!("Hello{open}x{close}"),
            "onStreamDelta sees the raw deltas, not the stripped text"
        );
        assert_eq!(
            transport.seen.lock().expect("lock")[0]
                .body
                .as_deref()
                .expect("body"),
            r#"{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hello"}],"max_tokens":4096,"temperature":0.7,"stream":true}"#
        );
    }

    /// `stream: true` without an event-stream content type falls through to the
    /// JSON parser, which then fails.
    #[tokio::test]
    async fn stream_flag_without_an_event_stream_is_parsed_as_json() {
        let transport = CapturingTransport::ok_json(
            r#"{"choices":[{"message":{"content":"plain"}}],"model":"m"}"#,
        );
        let mut request = user_request();
        request.stream = Some(true);
        let response = dispatch_openai_compatible_chat(
            &*transport,
            &StubAttachmentStore::default(),
            "https://api.example.com/v1",
            "sk",
            "openai",
            &request,
            &DispatchOptions::default(),
        )
        .await
        .expect("dispatch");
        assert_eq!(response.text, "plain");
    }

    #[tokio::test]
    async fn extra_headers_are_sent_after_the_authorization_header() {
        let transport = CapturingTransport::ok_json(r#"{"choices":[]}"#);
        let options = DispatchOptions::with_extra_headers(vec![
            (
                "HTTP-Referer".to_string(),
                "https://github.com/meco40/openworker".to_string(),
            ),
            ("X-Title".to_string(), "BetaClaw".to_string()),
        ]);
        dispatch_openai_compatible_chat(
            &*transport,
            &StubAttachmentStore::default(),
            "https://openrouter.ai/api/v1",
            "sk",
            "openrouter",
            &user_request(),
            &options,
        )
        .await
        .expect("dispatch");
        let seen = transport.seen.lock().expect("lock");
        assert_eq!(
            seen[0].headers.get("http-referer").expect("referer"),
            "https://github.com/meco40/openworker"
        );
        assert_eq!(seen[0].headers.get("x-title").expect("title"), "BetaClaw");
    }

    /// `response.json()` throwing is a transport-level failure in the port, which
    /// matches TypeScript propagating the `SyntaxError`.
    #[tokio::test]
    async fn an_undecodable_body_is_an_error() {
        let transport = CapturingTransport::ok_json("<html>gateway</html>");
        let error = dispatch_openai_compatible_chat(
            &*transport,
            &StubAttachmentStore::default(),
            "https://api.example.com/v1",
            "sk",
            "openai",
            &user_request(),
            &DispatchOptions::default(),
        )
        .await
        .expect_err("invalid body");
        assert!(matches!(error, HttpError::InvalidBody(_)), "{error:?}");
    }
}
