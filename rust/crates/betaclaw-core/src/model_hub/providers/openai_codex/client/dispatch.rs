//! Port of `src/server/model-hub/Models/openai-codex/client/dispatch.ts`.
//!
//! Every failure — a missing account id, a transport error, a non-2xx status, a
//! stream error event — becomes `{ ok: false, error }` with the provider id and
//! the *requested* model, exactly like `dispatch.ts:18-93`. Only the success
//! path substitutes the model the backend reported.
//!
//! The transport seam owns the deadline, so [`CODEX_REQUEST_TIMEOUT_MS`] travels
//! in the [`HttpRequest`] instead of a `setTimeout`, and a bodyless response
//! cannot be distinguished from an empty one (see
//! [`super::super::parsers::sse_parser`]).

use crate::model_hub::http::{fetch_with_timeout, AbortSignal, HttpRequest, HttpTransport};
use crate::model_hub::openai_compatible::utils::AttachmentStore;
use crate::model_hub::types::{GatewayRequest, GatewayResponse};

use super::super::constants::CODEX_REQUEST_TIMEOUT_MS;
use super::super::mappers::request_mapper::build_codex_request_body;
use super::super::parsers::parse_codex_http_error;
use super::super::parsers::rate_limit_parser::parse_codex_rate_limits_from_headers;
use super::super::parsers::sse_parser::parse_codex_sse_response;
use super::config::{build_codex_headers, resolve_codex_endpoint};

/// `provider: 'openai-codex'` — the literal every branch of `dispatch.ts` sets.
pub const PROVIDER_ID: &str = "openai-codex";

/// `dispatchCodexResponses(secret, request, options)` from `dispatch.ts:10-94`.
///
/// `on_stream_delta` is declared `Send` even though the SSE accumulator only
/// needs `FnMut`: the adapter returns a `Send` future, and a callback held
/// across the `await` would otherwise make it non-`Send`. It is erased to
/// `&mut dyn FnMut` right before the parse, so the parser stays
/// thread-agnostic.
pub async fn dispatch_codex_responses(
    transport: &dyn HttpTransport,
    attachments: &dyn AttachmentStore,
    secret: &str,
    request: &GatewayRequest,
    abort: Option<AbortSignal>,
    on_stream_delta: Option<&mut (dyn FnMut(&str) + Send)>,
) -> GatewayResponse {
    let endpoint = resolve_codex_endpoint(None);

    // `dispatch.ts:16-30`: a header failure is reported, not thrown.
    let headers = match build_codex_headers(secret) {
        Ok(headers) => headers,
        Err(error) => {
            return GatewayResponse::failure(request.model.clone(), PROVIDER_ID, error.message)
        }
    };

    let body = build_codex_request_body(request, attachments);

    let mut http_request = HttpRequest::post(endpoint)
        .json_body(&body)
        .timeout_ms(CODEX_REQUEST_TIMEOUT_MS);
    for (name, value) in headers {
        http_request = http_request.header(name, &value);
    }
    if let Some(abort) = abort {
        http_request = http_request.abort(abort);
    }

    let response = match fetch_with_timeout(transport, http_request).await {
        Ok(response) => response,
        Err(error) => {
            return GatewayResponse::failure(request.model.clone(), PROVIDER_ID, error.to_string())
        }
    };

    // `dispatch.ts:57-68`: the error body is read as text and the rate limits
    // come from the headers of the failed response.
    if !response.is_ok() {
        let rate_limits = parse_codex_rate_limits_from_headers(&response.headers);
        let mut failure = GatewayResponse::failure(
            request.model.clone(),
            PROVIDER_ID,
            parse_codex_http_error(&response.body, response.status.as_u16()),
        );
        failure.rate_limits = rate_limits;
        return failure;
    }

    let rate_limits = parse_codex_rate_limits_from_headers(&response.headers);

    let mut on_delta: Option<&mut dyn FnMut(&str)> = None;
    if let Some(callback) = on_stream_delta {
        on_delta = Some(callback);
    }

    match parse_codex_sse_response(&response.body, on_delta) {
        Ok(parsed) => {
            let model = parsed.model.unwrap_or_else(|| request.model.clone());
            let mut success = GatewayResponse::success(parsed.text, model, PROVIDER_ID);
            success.usage = parsed.usage;
            success.function_calls = parsed.function_calls;
            success.rate_limits = rate_limits;
            success
        }
        Err(error) => {
            let mut failure =
                GatewayResponse::failure(request.model.clone(), PROVIDER_ID, error.message);
            failure.rate_limits = rate_limits;
            failure
        }
    }
}
