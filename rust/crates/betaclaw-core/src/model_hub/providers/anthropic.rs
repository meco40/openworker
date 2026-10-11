//! Port of `src/server/model-hub/Models/anthropic/index.ts`.
//!
//! # Why there is no SDK-to-REST translation
//!
//! The Gemini adapter needed one because it drove `@google/genai`. This adapter
//! does not: `@anthropic-ai/sdk` appears nowhere in the TypeScript file, which
//! builds both requests by hand and sends them through the shared
//! `fetchWithTimeout` / `fetchJsonOk` helpers. The port therefore speaks the same
//! REST surface with nothing to translate:
//!
//! | TypeScript | REST |
//! | --- | --- |
//! | `fetchWithTimeout(`${ANTHROPIC_BASE_URL}/messages`, …, 60_000, options?.signal)` (`index.ts:302-315`) | `POST https://api.anthropic.com/v1/messages` with `x-api-key: <secret>`, `anthropic-version: 2023-06-01`, `content-type: application/json` |
//! | `fetchJsonOk(`${ANTHROPIC_BASE_URL}/messages`, …)` (`index.ts:236-248`) | the same endpoint, default 15 s timeout, `max_tokens: 4`, `messages: [{ role: 'user', content: 'ping' }]` |
//! | `fetchModels()` (`index.ts:214-228`) | **no request at all**: the ten model ids are a literal in the source, so `GET /v1/models` is never called |
//!
//! `ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1'` (`index.ts:51`) is the
//! `apiBaseUrl` of the `anthropic-native` catalog entry. The port keeps that
//! literal instead of reading `context.provider.api_base_url`, exactly like the
//! TypeScript does; only `provider.defaultModels[0]` is read from the context.
//!
//! | Rust | TypeScript |
//! | --- | --- |
//! | [`API_BASE_URL`], [`API_VERSION`] | `index.ts:50-51` |
//! | [`is_image_attachment`] (re-used) | `index.ts:53-55` |
//! | [`extract_base64_from_data_url`], [`DataUrlPayload`] | `index.ts:57-61` |
//! | [`map_openai_tool_to_anthropic`] | `index.ts:63-106` |
//! | [`build_anthropic_content_blocks`] | `index.ts:108-148` |
//! | [`build_anthropic_messages`] | `index.ts:150-184` |
//! | [`extract_anthropic_function_calls`] | `index.ts:186-209` |
//! | [`MODEL_IDS`], [`static_models`] | `fetchModels`, `index.ts:214-228` |
//! | [`MISSING_MODEL_MESSAGE`], [`CONNECTIVITY_OK`], [`CONNECTIVITY_FAILED_PREFIX`], [`build_ping_body`] | `testConnectivity`, `index.ts:230-253` |
//! | [`messages_url`] | `index.ts:236` and `index.ts:303` |
//! | [`build_gateway_body`], [`extract_anthropic_text`], [`extract_anthropic_usage`], [`extract_anthropic_model`], [`TYPE_ERROR_MESSAGE`] | `dispatchGateway`, `index.ts:255-370` |
//! | [`error_message_for_failed_response`] | the inline error branch, `index.ts:317-334` |
//! | [`AnthropicAdapter`] | `anthropicProviderAdapter`, `index.ts:211-382` |
//!
//! # Deliberate divergences
//!
//! 1. **`dispatchGateway` swallows everything.** `index.ts:256-380` wraps the whole
//!    body in `try { … } catch { }` and turns *any* failure — a transport error, a
//!    JSON parse error, the `TypeError` of divergence 4 — into
//!    `{ ok: false, error }`. [`AnthropicAdapter::dispatch_gateway`] therefore
//!    always returns `Ok` and reports every failure as
//!    [`GatewayResponse::failure`]; the `Err` variant of its return type is never
//!    produced. This matches the Gemini adapter and differs from the shared
//!    OpenAI-compatible layer, which lets a transport error escape.
//! 2. **The error branch is not the shared `parseErrorMessage`.** `index.ts:317-334`
//!    extracts the message itself, with a precedence that differs from
//!    `http.ts:50-69`: only `error.message` is consulted (no `error`-as-string, no
//!    top-level `message`), the raw body is used verbatim and **untrimmed** when
//!    `JSON.parse` fails or no message is present, and only an *empty* body falls
//!    back to `` `HTTP ${status}` ``. `fetchJsonOk`, by contrast, goes through
//!    `parseErrorMessage`. [`error_message_for_failed_response`] reproduces the
//!    inline branch, so an unparsable JSON body stays verbatim here (where the
//!    shared helper would print the status line) and the status fallback carries no
//!    reason phrase.
//! 3. **Nullish coalescing is not falsiness.** `request.max_tokens ?? 4096`
//!    (`index.ts:280`) keeps an explicit `0`; `errorJson.error?.message ?? errorText`
//!    keeps an empty `message` and returns the raw body only for a *missing* one
//!    (`index.ts:322`); `if (systemMessages)` and `if (trimmedContent)` use
//!    falsiness, so an empty join is skipped and an empty `attachment.mimeType`
//!    falls back to `application/octet-stream` (`index.ts:120`). Every one of those
//!    asymmetries is reproduced.
//! 4. **A non-array `content` is a failure, not a silent empty string.** The
//!    TypeScript writes `json.content?.filter(…)` (`index.ts:349-350`), which
//!    throws `TypeError: json.content?.filter is not a function` for any
//!    non-nullish non-array `content`; the `catch` turns that into
//!    `{ ok: false, error }`. The port returns the same failure with the message V8
//!    produces (verified with `node`, see [`TYPE_ERROR_MESSAGE`]). A *nullish*
//!    `content` is not an error: `?.` and `?? []` make it an empty block list, which
//!    the port also does.
//! 5. **Parse-error text.** `await response.json()` failing rejects with a V8
//!    `SyntaxError` (`Unexpected token '<', "<html>" is not valid JSON`). The port
//!    reports the `serde_json` error text instead. Both paths yield the same
//!    `{ ok: false }` shape; only the message differs.
//! 6. **Non-string JSON scalars.** `content[i].text`, `error.message` and
//!    `json.model` are typed as strings but JavaScript does not check that:
//!    `Array.prototype.join` coerces, `??` keeps whatever is there. The port
//!    stringifies scalars the way `String(value)` does and serialises an
//!    object/array value as JSON (where JS would produce `[object Object]`); a
//!    non-string `json.model` falls back to `request.model` instead of being copied
//!    into a `String` field.
//! 7. **Abort text.** A caller signal that fires makes Node reject with
//!    `AbortError: This operation was aborted`; [`HttpError::Aborted`] renders as
//!    `The operation was aborted`. The failure path itself is identical — the port
//!    never returns `Err` (divergence 1).
//! 8. **Attachments arrive through a seam.** `readStoredAttachmentAsDataUrl`
//!    (`index.ts:123`) reads from the persona-scoped attachment root. That path
//!    resolution belongs to the channels slice, so it is the injected
//!    [`AttachmentStore`] from `openai_compatible::utils`, exactly as in
//!    `request/build.ts`. The inline placeholder text of `index.ts:143` is *not*
//!    `utils.ts`'s `attachmentFallbackText`: it prints the fallback-ed MIME type.
//! 9. **Tool schema details.** `typeof parameters.properties === 'object'`
//!    (`index.ts:93`) accepts an *array* as well, so the port copies an array
//!    `properties` verbatim; `input_schema.required` is emitted whenever
//!    `parameters.required` is an array, including an empty one (`index.ts:96-98`).
//! 10. **Usage presence and token counts.** `json.usage ? …` (`index.ts:363`) is a
//!     truthiness test, so `usage: null`, `0`, `false` and `""` all mean "no
//!     usage"; the port reproduces that. `input_tokens`/`output_tokens` are
//!     `?? 0`-ed and read as `i64`, so a fractional count becomes `0` where
//!     TypeScript would keep the float.
//! 11. **No streaming.** `dispatchGateway` never sets `stream`, never asks for an
//!     SSE body and never calls `options.onStreamDelta`; the ping request does not
//!     stream either. [`DispatchOptions::on_stream_delta`] is therefore ignored, as
//!     the TypeScript ignores `options?.onStreamDelta` (`index.ts:255`).

use std::sync::LazyLock;

use regex::Regex;
use serde_json::{json, Map, Value};

use crate::model_hub::http::{
    fetch_json_ok, fetch_with_timeout, BoxFuture, HttpError, HttpRequest, HttpResponse,
    JsonOkResult, DEFAULT_GATEWAY_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS,
};
use crate::model_hub::openai_compatible::utils::{
    is_image_attachment, read_stored_attachment_as_data_url, AttachmentStore,
};
use crate::model_hub::openai_compatible::DispatchOptions;
use crate::model_hub::types::{
    ConnectivityResult, FetchedModel, GatewayFunctionCall, GatewayMessage, GatewayRequest,
    GatewayResponse, GatewayRole, GatewayUsage, ProviderExecutionContext,
};

use super::{ProviderAdapter, ProviderCall};

/// `ANTHROPIC_BASE_URL` from `anthropic/index.ts:51`.
pub const API_BASE_URL: &str = "https://api.anthropic.com/v1";

/// `ANTHROPIC_API_VERSION` from `anthropic/index.ts:50` — sent as the
/// `anthropic-version` header of both requests.
pub const API_VERSION: &str = "2023-06-01";

/// The `60_000` literal of `fetchWithTimeout(…, 60_000, options?.signal)`
/// (`anthropic/index.ts:313`).
///
/// Unlike the OpenAI-compatible layer, this adapter does not call
/// `resolveModelHubGatewayTimeoutMs`, so `MODEL_HUB_GATEWAY_TIMEOUT_MS` has no
/// effect on it. The literal equals the shared
/// [`DEFAULT_GATEWAY_TIMEOUT_MS`](crate::model_hub::http::DEFAULT_GATEWAY_TIMEOUT_MS).
pub const DISPATCH_TIMEOUT_MS: u64 = DEFAULT_GATEWAY_TIMEOUT_MS;

/// `request.max_tokens ?? 4096` from `anthropic/index.ts:280`.
pub const DEFAULT_MAX_TOKENS: i64 = 4096;

/// `max_tokens: 4` of the ping request, `anthropic/index.ts:245`.
pub const PING_MAX_TOKENS: i64 = 4;

/// `'Anthropic test requires a model id.'` from `anthropic/index.ts:233`.
pub const MISSING_MODEL_MESSAGE: &str = "Anthropic test requires a model id.";
/// `'Anthropic connectivity verified.'` from `anthropic/index.ts:251`.
pub const CONNECTIVITY_OK: &str = "Anthropic connectivity verified.";
/// The prefix of `` `Anthropic connectivity failed: ${result.message}` ``
/// (`anthropic/index.ts:252`).
pub const CONNECTIVITY_FAILED_PREFIX: &str = "Anthropic connectivity failed: ";
/// `'No valid messages to send'` from `anthropic/index.ts:272`.
pub const NO_VALID_MESSAGES: &str = "No valid messages to send";

/// `attachment.mimeType || 'application/octet-stream'` from
/// `anthropic/index.ts:120`.
pub const DEFAULT_ATTACHMENT_MIME_TYPE: &str = "application/octet-stream";

/// The `TypeError` message of a non-array `json.content`
/// (`anthropic/index.ts:349-350`, divergence 4).
///
/// Verified against V8 (Node): with `const json = { content: 5 }`, the expression
/// `json.content?.filter(…)` reports `json.content?.filter is not a function`. V8
/// prints the *source text* of the callee, so the optional chain keeps its `?.`.
pub const TYPE_ERROR_MESSAGE: &str = "json.content?.filter is not a function";

/// `` `${ANTHROPIC_BASE_URL}/messages` `` — the URL of both the dispatch
/// (`anthropic/index.ts:303`) and the ping request (`anthropic/index.ts:236`).
///
/// The secret travels in the `x-api-key` header, so there is no query string to
/// build and no `encodeURIComponent` helper like the Gemini adapter has.
pub fn messages_url() -> String {
    format!("{API_BASE_URL}/messages")
}

/// The `{ data, mediaType }` result of `extractBase64FromDataUrl`
/// (`anthropic/index.ts:57-61`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DataUrlPayload {
    /// `match[2]` — the base64 payload.
    pub data: String,
    /// `match[1]` — the media type between `data:` and `;base64,`.
    pub media_type: String,
}

/// `/^data:([^;]+);base64,(.+)$/` from `anthropic/index.ts:58`.
pub const DATA_URL_PATTERN: &str = r"^data:([^;]+);base64,(.+)$";

static DATA_URL_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(DATA_URL_PATTERN).expect("static regex is valid"));

/// `extractBase64FromDataUrl` from `anthropic/index.ts:57-61`.
///
/// The capture groups keep JavaScript's semantics: `media_type` may not contain a
/// `;`, `data` may not contain a newline (`.` excludes it in both regex dialects)
/// and both need at least one character. A media-type-less `data:;base64,…`
/// therefore yields `None` and the attachment degrades to its placeholder text —
/// which is reachable in practice, because `readStoredAttachmentAsDataUrl` builds
/// the URL from the raw `attachment.mimeType` and an empty one produces exactly
/// that.
pub fn extract_base64_from_data_url(data_url: &str) -> Option<DataUrlPayload> {
    let captures = DATA_URL_REGEX.captures(data_url)?;
    Some(DataUrlPayload {
        data: captures.get(2)?.as_str().to_string(),
        media_type: captures.get(1)?.as_str().to_string(),
    })
}

/// JavaScript truthiness of a JSON value: `false`, `0`, `""` and `null` are falsy,
/// everything else — including `[]` and `{}` — is truthy.
///
/// Needed by every `if (…)` of the source that no `??` guards: `if (systemMessages)`
/// (`index.ts:283`), `if (trimmedContent)` (`index.ts:115`), `!tool.function`
/// (`index.ts:79`), `!name` (`index.ts:82`) and `json.usage ? …` (`index.ts:363`).
fn is_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|parsed| parsed != 0.0),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `String(value)` for a non-nullish JSON value.
///
/// Used where TypeScript leans on implicit coercion: `join('')` over the `text`
/// blocks (`index.ts:352`) and `error.message` when it is not a string
/// (`index.ts:322`). Scalars stringify identically in both languages; an object or
/// array is serialised as JSON here where JS would print `[object Object]`
/// (divergence 6).
fn js_string_value(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => serde_json::to_string(other).unwrap_or_default(),
    }
}

/// `mapOpenAIToolToAnthropic` from `anthropic/index.ts:63-106`.
///
/// `None` for everything the source drops: a non-object, an array, a `type` that is
/// not the string `'function'`, a missing/falsy `function`, and a missing or empty
/// `name`. The result is `{ name, description, input_schema }` where `input_schema`
/// always carries `type: 'object'` and copies `properties` (verbatim, arrays
/// included) and the string-filtered `required` only when the respective
/// `parameters` key is present — an empty `required` array is kept
/// (divergence 9).
pub fn map_openai_tool_to_anthropic(raw_tool: &Value) -> Option<Value> {
    let tool = raw_tool.as_object()?;

    if tool.get("type").and_then(Value::as_str) != Some("function") {
        return None;
    }

    let function = tool.get("function").filter(|value| is_truthy(value))?;
    let function = function.as_object()?;
    let name = function
        .get("name")
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty())?;
    // `typeof tool.function.description === 'string' ? tool.function.description : ''`
    let description = function
        .get("description")
        .and_then(Value::as_str)
        .unwrap_or_default();

    let mut input_schema = Map::new();
    input_schema.insert("type".to_string(), Value::from("object"));

    // `if (parameters && typeof parameters === 'object' && !Array.isArray(parameters))`
    if let Some(parameters) = function.get("parameters").and_then(Value::as_object) {
        // `if (parameters.properties && typeof parameters.properties === 'object')` —
        // an array satisfies this in JavaScript, so it does here (divergence 9).
        if let Some(properties) = parameters
            .get("properties")
            .filter(|value| is_truthy(value))
            .filter(|value| value.is_object() || value.is_array())
        {
            input_schema.insert("properties".to_string(), properties.clone());
        }
        // `if (Array.isArray(parameters.required))` plus a `typeof … === 'string'`
        // filter, so an empty array is still emitted and non-strings are dropped.
        if let Some(required) = parameters.get("required").and_then(Value::as_array) {
            let required: Vec<Value> = required
                .iter()
                .filter_map(Value::as_str)
                .map(Value::from)
                .collect();
            input_schema.insert("required".to_string(), Value::Array(required));
        }
    }

    let mut mapped = Map::new();
    mapped.insert("name".to_string(), Value::from(name));
    mapped.insert("description".to_string(), Value::from(description));
    mapped.insert("input_schema".to_string(), Value::Object(input_schema));
    Some(Value::Object(mapped))
}

/// `buildAnthropicContentBlocks` from `anthropic/index.ts:108-148`.
///
/// The text block of `index.ts:115-117` is pushed first, and only when the *trimmed*
/// content is non-empty. Every attachment then either becomes an `image` block —
/// only on the latest user message that has attachments, and only for an image MIME
/// type whose stored file yields a parsable data URL — or the placeholder text of
/// `index.ts:141-144`, which prints the `||`-defaulted MIME type and therefore is
/// *not* `utils.ts`'s `attachmentFallbackText`.
pub fn build_anthropic_content_blocks(
    store: &dyn AttachmentStore,
    message: &GatewayMessage,
    include_binary_attachments: bool,
) -> Vec<Value> {
    let mut blocks: Vec<Value> = Vec::new();

    let trimmed_content = message.content.trim();
    if !trimmed_content.is_empty() {
        blocks.push(json!({ "type": "text", "text": trimmed_content }));
    }

    for attachment in message.attachments() {
        // `const mimeType = attachment.mimeType || 'application/octet-stream'`
        let mime_type = if attachment.mime_type.is_empty() {
            DEFAULT_ATTACHMENT_MIME_TYPE.to_string()
        } else {
            attachment.mime_type.clone()
        };

        if include_binary_attachments && is_image_attachment(&mime_type) {
            if let Some(data_url) = read_stored_attachment_as_data_url(store, attachment) {
                if let Some(payload) = extract_base64_from_data_url(&data_url) {
                    blocks.push(json!({
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": payload.media_type,
                            "data": payload.data,
                        },
                    }));
                    continue;
                }
            }
        }

        // Fallback for non-image attachments (`index.ts:140-144`).
        blocks.push(json!({
            "type": "text",
            "text": format!(
                "[Attachment: {} ({}, {} bytes)]",
                attachment.name, mime_type, attachment.size
            ),
        }));
    }

    blocks
}

/// `buildAnthropicMessages` from `anthropic/index.ts:150-184`.
///
/// A system message never reaches the array (its text travels in `system`), a user
/// message is dropped when its block list is empty, and an assistant turn keeps its
/// plain trimmed string instead of a block list. Binary attachments are inlined for
/// the **last** user message that has any (`index.ts:156-164`), so an earlier user
/// image degrades to the placeholder text.
pub fn build_anthropic_messages(
    store: &dyn AttachmentStore,
    messages: &[GatewayMessage],
) -> Vec<Value> {
    let latest_user_attachment_index = messages
        .iter()
        .enumerate()
        .rev()
        .find(|(_, message)| message.role == GatewayRole::User && !message.attachments().is_empty())
        .map(|(index, _)| index);

    let mut result = Vec::new();
    for (index, message) in messages.iter().enumerate() {
        match message.role {
            GatewayRole::System => continue,
            GatewayRole::User => {
                let content = build_anthropic_content_blocks(
                    store,
                    message,
                    Some(index) == latest_user_attachment_index,
                );
                // `if (content.length > 0)` — a user message with neither text nor
                // attachments disappears instead of being sent as an empty list.
                if !content.is_empty() {
                    result.push(json!({ "role": "user", "content": content }));
                }
            }
            GatewayRole::Assistant => {
                let trimmed_content = message.content.trim();
                if !trimmed_content.is_empty() {
                    result.push(json!({ "role": "assistant", "content": trimmed_content }));
                }
            }
        }
    }
    result
}

/// `extractAnthropicFunctionCalls` from `anthropic/index.ts:186-209`.
///
/// Only a non-array object block whose `type` is exactly `'tool_use'` and whose
/// `name` is a string contributes a call. `args` copies `block.input` verbatim, so
/// it is `None` when the key is absent and `Some(Value::Null)` for an explicit
/// `input: null` — the same distinction `JSON.stringify` makes between `undefined`
/// and `null`.
pub fn extract_anthropic_function_calls(blocks: &[Value]) -> Vec<GatewayFunctionCall> {
    let mut calls = Vec::new();
    for block in blocks {
        let Some(typed_block) = block.as_object() else {
            continue;
        };
        if typed_block.get("type").and_then(Value::as_str) != Some("tool_use") {
            continue;
        }
        let Some(name) = typed_block.get("name").and_then(Value::as_str) else {
            continue;
        };
        calls.push(GatewayFunctionCall {
            name: name.to_string(),
            args: typed_block.get("input").cloned(),
        });
    }
    calls
}

/// `json.content ?? []` plus the `json.content?.filter(…)` type check of
/// `anthropic/index.ts:349-350`.
///
/// A missing or `null` `content` yields an empty block list (`?.` short-circuits and
/// `?? []` substitutes). Any other non-array value is the `TypeError` of divergence
/// 4, which the caller turns into a failed response.
fn resolve_content_blocks(json: &Value) -> Result<Vec<Value>, String> {
    match json.get("content") {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Array(blocks)) => Ok(blocks.clone()),
        Some(_) => Err(TYPE_ERROR_MESSAGE.to_string()),
    }
}

/// `json.content?.filter(block => block.type === 'text').map(block => block.text ?? '').join('')`
/// from `anthropic/index.ts:347-352`.
///
/// `join('')` leaves no separator between the blocks. The `?? ''` keeps an empty
/// string but substitutes for a missing or `null` `text`, and a non-string `text` is
/// coerced with `String()` semantics (divergence 6).
pub fn extract_anthropic_text(blocks: &[Value]) -> String {
    let mut text = String::new();
    for block in blocks {
        let Some(typed_block) = block.as_object() else {
            continue;
        };
        if typed_block.get("type").and_then(Value::as_str) != Some("text") {
            continue;
        }
        if let Some(value) = typed_block.get("text").filter(|value| !value.is_null()) {
            text.push_str(&js_string_value(value));
        }
    }
    text
}

/// `json.usage ? { … } : undefined` from `anthropic/index.ts:363-369`.
///
/// The guard is a truthiness test, so `null`, `0`, `false` and `""` all mean "no
/// usage" while `{}` yields three zeros. `input_tokens`/`output_tokens` are read with
/// `?? 0` and `total_tokens` is their sum, exactly as in the source; a non-integer
/// count becomes `0` (divergence 10).
pub fn extract_anthropic_usage(json: &Value) -> Option<GatewayUsage> {
    let usage = json.get("usage").filter(|value| is_truthy(value))?;
    let prompt_tokens = token_count(usage.get("input_tokens"));
    let completion_tokens = token_count(usage.get("output_tokens"));
    Some(GatewayUsage {
        prompt_tokens,
        completion_tokens,
        total_tokens: prompt_tokens + completion_tokens,
    })
}

/// `value ?? 0` for a token count the API may omit.
fn token_count(value: Option<&Value>) -> i64 {
    value.and_then(Value::as_i64).unwrap_or(0)
}

/// `json.model ?? request.model` from `anthropic/index.ts:360`.
pub fn extract_anthropic_model(json: &Value, request_model: &str) -> String {
    json.get("model")
        .filter(|model| !model.is_null())
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| request_model.to_string())
}

/// The inline error branch of `anthropic/index.ts:317-334`.
///
/// Transcribing `` errorJson.error?.message ?? errorText ?? `HTTP ${response.status}` ``:
///
/// 1. the body is parsed as JSON. If it parses **and** `error.message` is neither
///    missing nor `null`, that value is the message — an empty string included,
///    because `??` only reacts to nullish values;
/// 2. if it parses without such a message, the raw body text is the message (a
///    `JSON.parse`-able body is never replaced by the status line, unlike
///    [`parse_error_message`](crate::model_hub::http::parse_error_message));
/// 3. if it does not parse, `errorText || `HTTP ${status}`` decides: the raw,
///    **untrimmed** body for anything but the empty string, and otherwise the
///    `` `HTTP ${status}` `` literal — no reason phrase, unlike the shared helper.
pub fn error_message_for_failed_response(response: &HttpResponse) -> String {
    let error_text = response.body.as_str();
    match serde_json::from_str::<Value>(error_text) {
        Ok(json) => json
            .get("error")
            .and_then(|error| error.get("message"))
            .filter(|message| !message.is_null())
            .map(js_string_value)
            .unwrap_or_else(|| error_text.to_string()),
        Err(_) => {
            if error_text.is_empty() {
                format!("HTTP {}", response.status.as_u16())
            } else {
                error_text.to_string()
            }
        }
    }
}

/// The `POST /v1/messages` body of `dispatchGateway`
/// (`anthropic/index.ts:277-300`).
///
/// Key order follows the source — `model`, `messages`, `max_tokens`, then the
/// optional `system`, `temperature` and `tools` — so the serialised body is
/// byte-comparable with `JSON.stringify` of the TypeScript object (`serde_json` is
/// built with `preserve_order`).
///
/// `messages` is passed in already built, because `dispatchGateway` computes the
/// block list once and short-circuits on an empty one before any body exists
/// (`index.ts:264-274`).
pub fn build_gateway_body(request: &GatewayRequest, messages: Vec<Value>) -> Value {
    let mut body = Map::new();
    body.insert("model".to_string(), Value::from(request.model.clone()));
    body.insert("messages".to_string(), Value::Array(messages));
    // `request.max_tokens ?? 4096` — nullish, so an explicit 0 survives.
    body.insert(
        "max_tokens".to_string(),
        Value::from(request.max_tokens.unwrap_or(DEFAULT_MAX_TOKENS)),
    );

    // `request.messages.filter(role === 'system').map(content).join('\n')`, then
    // `if (systemMessages)`: an empty join is skipped instead of sent as "".
    let system_messages = request
        .messages
        .iter()
        .filter(|message| message.role == GatewayRole::System)
        .map(|message| message.content.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    if !system_messages.is_empty() {
        body.insert("system".to_string(), Value::from(system_messages));
    }

    // `if (request.temperature !== undefined)` — an explicit 0 survives too.
    if let Some(temperature) = request.temperature {
        body.insert("temperature".to_string(), Value::from(temperature));
    }

    // `if (Array.isArray(request.tools) && request.tools.length > 0)` followed by a
    // second guard on the *mapped* list, so a tools array whose entries are all
    // unmappable does not emit the key at all.
    if let Some(tools) = request.tools.as_deref().filter(|tools| !tools.is_empty()) {
        let mapped: Vec<Value> = tools
            .iter()
            .filter_map(map_openai_tool_to_anthropic)
            .collect();
        if !mapped.is_empty() {
            body.insert("tools".to_string(), Value::Array(mapped));
        }
    }

    Value::Object(body)
}

/// The `testConnectivity` request body of `anthropic/index.ts:243-247`.
///
/// `content: 'ping'` is a plain string rather than a block list, and the key order is
/// `model`, `max_tokens`, `messages` — not the dispatch order.
pub fn build_ping_body(model: &str) -> Value {
    json!({
        "model": model,
        "max_tokens": PING_MAX_TOKENS,
        "messages": [{ "role": "user", "content": "ping" }],
    })
}

/// The ten ids of `anthropic/index.ts:215-226`, in source order.
pub const MODEL_IDS: &[&str] = &[
    "claude-sonnet-4-5",
    "claude-sonnet-4-5-20250514",
    "claude-3-7-sonnet-latest",
    "claude-3-7-sonnet-20250219",
    "claude-3-5-haiku-latest",
    "claude-3-5-haiku-20241022",
    "claude-3-opus-latest",
    "claude-3-opus-20240229",
    "claude-3-5-sonnet-latest",
    "claude-3-5-sonnet-20241022",
];

/// `fetchModels()` from `anthropic/index.ts:214-228`.
///
/// The list is a literal and the method takes no context in TypeScript, so no request
/// is made and no error is possible: `models.map((id) => ({ id, name: id, provider:
/// 'anthropic' }))`. `owned_by`, `context_window`, `created` and `billing` stay unset,
/// and the id doubles as the display name.
pub fn static_models() -> Vec<FetchedModel> {
    MODEL_IDS
        .iter()
        .map(|id| FetchedModel {
            id: (*id).to_string(),
            name: (*id).to_string(),
            provider: "anthropic".to_string(),
            owned_by: None,
            context_window: None,
            created: None,
            billing: None,
        })
        .collect()
}

/// `anthropicProviderAdapter` from `anthropic/index.ts:211-382`.
#[derive(Debug, Clone, Copy, Default)]
pub struct AnthropicAdapter;

impl ProviderAdapter for AnthropicAdapter {
    fn id(&self) -> &'static str {
        "anthropic"
    }

    /// `fetchModels()` (`index.ts:214-228`) — the literal list of [`static_models`],
    /// no request and therefore no failure mode. `context` and `call` are unused
    /// because the TypeScript method takes no argument at all.
    fn fetch_models<'a>(
        &'a self,
        _context: &'a ProviderExecutionContext,
        _call: &'a ProviderCall<'_>,
    ) -> BoxFuture<'a, Result<Vec<FetchedModel>, HttpError>> {
        Box::pin(async move { Ok(static_models()) })
    }

    /// `testConnectivity({ provider, secret }, options)` (`index.ts:230-253`).
    ///
    /// `options.model || provider.defaultModels[0]` is a *falsy* fallback, so an
    /// empty model id falls through to the catalog default; when both are empty the
    /// check fails before any request is sent. The outcome is decided by
    /// `fetchJsonOk`, which means any 2xx answer verifies — even one without
    /// `content` — and a non-2xx answer reports its `parseErrorMessage` text behind
    /// the `Anthropic connectivity failed: ` prefix.
    fn test_connectivity<'a>(
        &'a self,
        context: &'a ProviderExecutionContext,
        call: &'a ProviderCall<'_>,
        model: Option<&'a str>,
    ) -> BoxFuture<'a, ConnectivityResult> {
        Box::pin(async move {
            let model = model
                .filter(|value| !value.is_empty())
                .map(str::to_string)
                .or_else(|| context.provider.default_models.first().cloned())
                .filter(|value| !value.is_empty());

            let Some(model) = model else {
                return ConnectivityResult::failed(MISSING_MODEL_MESSAGE);
            };

            let request = HttpRequest::post(messages_url())
                .header("x-api-key", &context.secret)
                .header("anthropic-version", API_VERSION)
                .header("content-type", "application/json")
                .json_body(&build_ping_body(&model));

            // `fetchJsonOk(url, init)` without a third argument: the default 15 s.
            match fetch_json_ok(call.transport, request, DEFAULT_REQUEST_TIMEOUT_MS).await {
                JsonOkResult::Ok(_) => ConnectivityResult::ok(CONNECTIVITY_OK),
                JsonOkResult::Err(message) => {
                    ConnectivityResult::failed(format!("{CONNECTIVITY_FAILED_PREFIX}{message}"))
                }
            }
        })
    }

    /// `dispatchGateway({ secret }, request, options)` (`index.ts:255-381`).
    ///
    /// Error policy (divergence 1): the `try { … } catch { }` of `index.ts:256-380`
    /// turns every failure into `{ ok: false, error }`, so this method always returns
    /// `Ok` and never propagates an [`HttpError`]. The empty-message short-circuit
    /// runs before the request is built, so a system-only conversation never reaches
    /// the transport.
    fn dispatch_gateway<'a>(
        &'a self,
        context: &'a ProviderExecutionContext,
        call: &'a ProviderCall<'_>,
        request: &'a GatewayRequest,
        options: &'a DispatchOptions,
    ) -> BoxFuture<'a, Result<GatewayResponse, HttpError>> {
        Box::pin(async move {
            let messages = build_anthropic_messages(call.attachments, &request.messages);
            if messages.is_empty() {
                return Ok(GatewayResponse::failure(
                    request.model.clone(),
                    self.id(),
                    NO_VALID_MESSAGES,
                ));
            }

            let mut http_request = HttpRequest::post(messages_url())
                .header("x-api-key", &context.secret)
                .header("anthropic-version", API_VERSION)
                .header("content-type", "application/json")
                .timeout_ms(DISPATCH_TIMEOUT_MS)
                .json_body(&build_gateway_body(request, messages));
            // `options?.signal`. `onStreamDelta` has no counterpart, because the
            // adapter never streams (divergence 11).
            if let Some(abort) = &options.abort {
                http_request = http_request.abort(abort.clone());
            }

            match fetch_with_timeout(call.transport, http_request).await {
                Ok(response) if !response.is_ok() => Ok(GatewayResponse::failure(
                    request.model.clone(),
                    self.id(),
                    error_message_for_failed_response(&response),
                )),
                Ok(response) => match serde_json::from_str::<Value>(&response.body) {
                    Ok(json) => match resolve_content_blocks(&json) {
                        Ok(blocks) => {
                            let function_calls = extract_anthropic_function_calls(&blocks);
                            let mut result = GatewayResponse::success(
                                extract_anthropic_text(&blocks),
                                extract_anthropic_model(&json, &request.model),
                                self.id(),
                            );
                            result.usage = extract_anthropic_usage(&json);
                            result.function_calls =
                                (!function_calls.is_empty()).then_some(function_calls);
                            Ok(result)
                        }
                        // The `TypeError` the `catch` would report (divergence 4).
                        Err(message) => Ok(GatewayResponse::failure(
                            request.model.clone(),
                            self.id(),
                            message,
                        )),
                    },
                    Err(error) => Ok(GatewayResponse::failure(
                        request.model.clone(),
                        self.id(),
                        error.to_string(),
                    )),
                },
                Err(error) => Ok(GatewayResponse::failure(
                    request.model.clone(),
                    self.id(),
                    error.to_string(),
                )),
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use http::{HeaderMap, StatusCode};

    use super::*;
    use crate::model_hub::env::EnvOverrides;
    use crate::model_hub::http::{AbortSignal, HttpResponse, HttpTransport, UnreachableTransport};
    use crate::model_hub::openai_compatible::NOOP_ATTACHMENT_STORE;
    use crate::model_hub::provider_catalog::find_provider;
    use crate::model_hub::repository::encrypted_secret_input;
    use crate::model_hub::tests::StubAttachmentStore;
    use crate::model_hub::types::{
        GatewayMessageAttachment, ProviderAccountRecord, ProviderAuthMethod,
    };

    /// A key-shaped string. The adapter sends it verbatim in `x-api-key` — unlike the
    /// OpenAI-compatible layer it never runs `normalizeBearerSecret`.
    const SECRET: &str = "sk-ant-api03-not-a-real-key";

    /// Records every request and replays one canned response.
    struct StubTransport {
        response: HttpResponse,
        seen: Mutex<Vec<HttpRequest>>,
    }

    impl StubTransport {
        fn new(response: HttpResponse) -> Arc<Self> {
            Arc::new(Self {
                response,
                seen: Mutex::new(Vec::new()),
            })
        }
    }

    impl HttpTransport for StubTransport {
        fn send<'a>(
            &'a self,
            request: HttpRequest,
        ) -> BoxFuture<'a, Result<HttpResponse, HttpError>> {
            self.seen.lock().expect("lock").push(request.clone());
            let response = self.response.clone();
            Box::pin(async move { Ok(response) })
        }
    }

    fn call<'a>(
        transport: &'a dyn HttpTransport,
        store: &'a dyn AttachmentStore,
        env: &'a EnvOverrides,
    ) -> ProviderCall<'a> {
        ProviderCall {
            transport,
            attachments: store,
            env,
        }
    }

    fn context(secret: &str) -> ProviderExecutionContext {
        ProviderExecutionContext {
            provider: find_provider("anthropic")
                .expect("anthropic is in the catalog")
                .clone(),
            account: ProviderAccountRecord {
                id: "acc-1".to_string(),
                provider_id: "anthropic".to_string(),
                label: "anthropic".to_string(),
                auth_method: ProviderAuthMethod::ApiKey,
                secret_masked: "****".to_string(),
                has_refresh_token: false,
                created_at: "2026-01-01T00:00:00.000Z".to_string(),
                updated_at: "2026-01-01T00:00:00.000Z".to_string(),
                last_check_at: None,
                last_check_ok: None,
                last_check_message: None,
                encrypted_secret: encrypted_secret_input(
                    "aes-256-gcm",
                    "default",
                    "iv",
                    "cipher",
                    "tag",
                ),
                encrypted_refresh_token: None,
            },
            secret: secret.to_string(),
        }
    }

    /// The only way to reach the `'Anthropic test requires a model id.'` branch:
    /// `provider.defaultModels` is empty, as it is for a hand-edited account.
    fn context_without_default_models() -> ProviderExecutionContext {
        let mut context = context(SECRET);
        context.provider.default_models.clear();
        context
    }

    fn attachment(
        name: &str,
        mime_type: &str,
        size: i64,
        storage_path: &str,
    ) -> GatewayMessageAttachment {
        GatewayMessageAttachment {
            name: name.to_string(),
            mime_type: mime_type.to_string(),
            size,
            storage_path: storage_path.to_string(),
            sha256: None,
        }
    }

    fn user_with_attachment(content: &str, name: &str, mime_type: &str) -> GatewayMessage {
        let mut message = GatewayMessage::user(content);
        message.attachments = Some(vec![attachment(name, mime_type, 7, name)]);
        message
    }

    /// The body of the first request the stub saw.
    fn sent_body(transport: &StubTransport) -> String {
        transport.seen.lock().expect("lock")[0]
            .body
            .clone()
            .expect("body")
    }

    /// `https://api.anthropic.com/v1/messages` — the single endpoint of the file
    /// (`anthropic/index.ts:236` and `anthropic/index.ts:303`).
    #[test]
    fn messages_url_is_the_api_base_plus_messages() {
        assert_eq!(API_BASE_URL, "https://api.anthropic.com/v1");
        assert_eq!(messages_url(), "https://api.anthropic.com/v1/messages");
        assert_eq!(API_VERSION, "2023-06-01");
        assert_eq!(DISPATCH_TIMEOUT_MS, 60_000);
    }

    /// `fetchModels()` is a literal list, so it sends no request and cannot fail.
    #[tokio::test]
    async fn fetch_models_returns_the_literal_list_without_a_request() {
        let transport = StubTransport::new(HttpResponse::json(StatusCode::OK, &json!({})));
        let env = EnvOverrides::new();
        let models = AnthropicAdapter
            .fetch_models(
                &context(SECRET),
                &call(&*transport, &NOOP_ATTACHMENT_STORE, &env),
            )
            .await
            .expect("models");

        assert_eq!(models.len(), 10);
        assert_eq!(models.len(), MODEL_IDS.len());
        assert_eq!(models[0].id, "claude-sonnet-4-5");
        assert_eq!(models[0].name, models[0].id, "`name` echoes the id");
        assert_eq!(models[0].provider, "anthropic");
        assert_eq!(models[9].id, "claude-3-5-sonnet-20241022");
        assert_eq!(models[0].owned_by, None);
        assert_eq!(models[0].context_window, None);
        assert_eq!(models[0].created, None);
        assert_eq!(models[0].billing, None);
        assert!(
            transport.seen.lock().expect("lock").is_empty(),
            "GET /v1/models is never called"
        );
        assert_eq!(
            find_provider("anthropic").expect("catalog").default_models[0],
            MODEL_IDS[0],
            "the ping model is the first catalog default"
        );
    }

    /// `mapOpenAIToolToAnthropic` of `anthropic/index.ts:63-106`: the OpenAI shape is
    /// rewritten, `required` keeps only strings and `input_schema.type` is always
    /// `'object'`.
    #[test]
    fn map_openai_tool_to_anthropic_copies_the_supported_shape() {
        let mapped = map_openai_tool_to_anthropic(&json!({
            "type": "function",
            "function": {
                "name": "get_weather",
                "description": "Look up the weather",
                "parameters": {
                    "type": "object",
                    "properties": { "city": { "type": "string" } },
                    "required": ["city", 7, "unit"]
                }
            }
        }))
        .expect("mapped tool");

        assert_eq!(
            mapped,
            json!({
                "name": "get_weather",
                "description": "Look up the weather",
                "input_schema": {
                    "type": "object",
                    "properties": { "city": { "type": "string" } },
                    "required": ["city", "unit"]
                }
            })
        );
    }

    /// The defaults of `anthropic/index.ts:84-99`: a missing `description` becomes
    /// `''`, a `properties` *array* is copied verbatim (`typeof [] === 'object'`), an
    /// empty `required` array is kept, and anything else leaves
    /// `input_schema = { type: 'object' }`.
    #[test]
    fn map_openai_tool_to_anthropic_keeps_the_source_defaults() {
        let mapped = map_openai_tool_to_anthropic(&json!({
            "type": "function",
            "function": {
                "name": "ping",
                "parameters": { "properties": [{ "type": "string" }], "required": [] }
            }
        }))
        .expect("mapped tool");
        assert_eq!(
            mapped,
            json!({
                "name": "ping",
                "description": "",
                "input_schema": {
                    "type": "object",
                    "properties": [{ "type": "string" }],
                    "required": []
                }
            })
        );

        for parameters in [None, Some(json!([])), Some(json!("object"))] {
            let mut function = json!({ "name": "ping" });
            if let Some(parameters) = parameters {
                function["parameters"] = parameters;
            }
            let mapped = map_openai_tool_to_anthropic(&json!({
                "type": "function",
                "function": function
            }))
            .expect("mapped tool");
            assert_eq!(
                mapped,
                json!({
                    "name": "ping",
                    "description": "",
                    "input_schema": { "type": "object" }
                })
            );
        }
    }

    /// Every shape `anthropic/index.ts:64-82` drops: non-objects, arrays, a
    /// non-`function` type, a missing/falsy `function`, and a missing, empty or
    /// non-string `name`.
    #[test]
    fn map_openai_tool_to_anthropic_drops_unsupported_tools() {
        for raw in [
            json!(null),
            json!([{ "type": "function", "function": { "name": "x" } }]),
            json!("function"),
            json!(7),
            json!({ "type": "other", "function": { "name": "x" } }),
            json!({ "type": "function" }),
            json!({ "type": "function", "function": null }),
            json!({ "type": "function", "function": 0 }),
            json!({ "type": "function", "function": "get_weather" }),
            json!({ "type": "function", "function": { "description": "no name" } }),
            json!({ "type": "function", "function": { "name": "" } }),
            json!({ "type": "function", "function": { "name": 7 } }),
        ] {
            assert_eq!(map_openai_tool_to_anthropic(&raw), None, "{raw}");
        }
    }

    /// `/^data:([^;]+);base64,(.+)$/` (`anthropic/index.ts:58`) in every direction
    /// that matters: the media type may not contain a `;`, the payload needs at least
    /// one character and may not contain a newline.
    #[test]
    fn extract_base64_from_data_url_follows_the_source_regex() {
        let payload =
            extract_base64_from_data_url("data:image/png;base64,UE5HREFUQQ==").expect("payload");
        assert_eq!(payload.data, "UE5HREFUQQ==");
        assert_eq!(payload.media_type, "image/png");

        // `data:;base64,…` — the empty media type cannot match `[^;]+`, which is
        // reachable because the store builds the URL from the raw `mimeType`.
        assert_eq!(extract_base64_from_data_url("data:;base64,QQ=="), None);
        // No `;base64,` marker at all.
        assert_eq!(extract_base64_from_data_url("data:image/png,QQ=="), None);
        // `(.+)` needs a payload.
        assert_eq!(extract_base64_from_data_url("data:image/png;base64,"), None);
        // A `;` inside the media type: the first `;` must be the marker.
        assert_eq!(
            extract_base64_from_data_url("data:image/png;charset=utf-8;base64,QQ=="),
            None
        );
        // `.` does not match a newline in either dialect.
        assert_eq!(
            extract_base64_from_data_url("data:image/png;base64,QQ\n=="),
            None
        );
    }

    /// `buildAnthropicMessages` (`anthropic/index.ts:150-184`): system turns are
    /// dropped, an empty user turn disappears, an assistant turn keeps its trimmed
    /// string, and a non-image attachment becomes the placeholder text of
    /// `index.ts:143` — with the `||`-defaulted MIME type.
    #[test]
    fn build_anthropic_messages_drops_system_and_empty_turns() {
        let store = NOOP_ATTACHMENT_STORE;
        let messages = vec![
            GatewayMessage::new(GatewayRole::System, "be terse"),
            GatewayMessage::user("   "),
            GatewayMessage::new(GatewayRole::Assistant, "  hi  "),
            GatewayMessage::new(GatewayRole::User, ""),
            user_with_attachment("look", "note.pdf", "application/pdf"),
        ];

        assert_eq!(
            build_anthropic_messages(&store, &messages),
            vec![
                json!({ "role": "assistant", "content": "hi" }),
                json!({
                    "role": "user",
                    "content": [
                        { "type": "text", "text": "look" },
                        { "type": "text", "text": "[Attachment: note.pdf (application/pdf, 7 bytes)]" }
                    ]
                }),
            ]
        );

        let mut empty_mime = user_with_attachment("file", "blob.bin", "");
        empty_mime.attachments = Some(vec![attachment("blob.bin", "", 12, "blob.bin")]);
        assert_eq!(
            build_anthropic_messages(&store, &[empty_mime]),
            vec![json!({
                "role": "user",
                "content": [
                    { "type": "text", "text": "file" },
                    { "type": "text", "text": "[Attachment: blob.bin (application/octet-stream, 12 bytes)]" }
                ]
            })]
        );

        // A system-only conversation yields no messages at all, which is the
        // `'No valid messages to send'` path of `dispatchGateway`.
        assert_eq!(
            build_anthropic_messages(&store, &[GatewayMessage::new(GatewayRole::System, "sys")]),
            Vec::<Value>::new()
        );
    }

    /// Only the *latest* user message with attachments inlines its images
    /// (`anthropic/index.ts:156-164`); an earlier user image degrades to the
    /// placeholder text, and the base64 payload is copied out of the data URL.
    #[test]
    fn the_latest_user_message_with_attachments_inlines_its_image() {
        let store = StubAttachmentStore::new(vec![("a.png", "image/png", b"PNGDATA".to_vec())]);
        let messages = vec![
            user_with_attachment("first", "a.png", "image/png"),
            GatewayMessage::user("middle"),
            user_with_attachment("second", "a.png", "image/png"),
        ];

        let built = build_anthropic_messages(&store, &messages);
        assert_eq!(built.len(), 3);
        assert_eq!(
            built[0],
            json!({
                "role": "user",
                "content": [
                    { "type": "text", "text": "first" },
                    { "type": "text", "text": "[Attachment: a.png (image/png, 7 bytes)]" }
                ]
            }),
            "the earlier image is not inlined"
        );
        assert_eq!(
            built[2],
            json!({
                "role": "user",
                "content": [
                    { "type": "text", "text": "second" },
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": "image/png",
                            "data": "UE5HREFUQQ=="
                        }
                    }
                ]
            })
        );
    }

    /// A missing file and an empty file are both degraded to the placeholder text:
    /// `readStoredAttachmentAsDataUrl` returns `null` and the adapter falls through.
    #[test]
    fn an_unreadable_image_attachment_degrades_to_the_placeholder() {
        let store = StubAttachmentStore::default();
        assert_eq!(
            build_anthropic_messages(
                &store,
                &[user_with_attachment("x", "gone.png", "image/png")]
            ),
            vec![json!({
                "role": "user",
                "content": [
                    { "type": "text", "text": "x" },
                    { "type": "text", "text": "[Attachment: gone.png (image/png, 7 bytes)]" }
                ]
            })]
        );
    }

    /// A request that exercises every optional key of the dispatch body: two system
    /// turns, a padded user turn, an assistant turn, and a tools array with one
    /// mappable and one unmappable entry.
    fn gateway_request() -> GatewayRequest {
        let mut request = GatewayRequest::new(
            "claude-sonnet-4-5",
            vec![
                GatewayMessage::new(GatewayRole::System, "Be terse."),
                GatewayMessage::new(GatewayRole::System, "Answer in English."),
                GatewayMessage::user("  hello  "),
                GatewayMessage::new(GatewayRole::Assistant, "hi"),
                GatewayMessage::user("say more"),
            ],
        );
        request.max_tokens = Some(64);
        request.temperature = Some(0.25);
        request.tools = Some(vec![
            json!({
                "type": "function",
                "function": {
                    "name": "get_weather",
                    "description": "Look up the weather",
                    "parameters": {
                        "type": "object",
                        "properties": { "city": { "type": "string" } },
                        "required": ["city", 7]
                    }
                }
            }),
            json!({ "type": "unsupported" }),
        ]);
        request
    }

    /// `dispatchGateway` on the happy path: the URL, the three headers, the exact body
    /// (key order included) and the reply parsing of `anthropic/index.ts:336-370`.
    #[tokio::test]
    async fn dispatch_gateway_sends_the_messages_request() {
        let transport = StubTransport::new(HttpResponse::json(
            StatusCode::OK,
            &json!({
                "id": "msg_01",
                "model": "claude-sonnet-4-5-20250514",
                "content": [
                    { "type": "text", "text": "Hello" },
                    {
                        "type": "tool_use",
                        "id": "toolu_1",
                        "name": "get_weather",
                        "input": { "city": "Berlin" }
                    },
                    { "type": "text", "text": " world" }
                ],
                "usage": { "input_tokens": 12, "output_tokens": 5 }
            }),
        ));
        let env = EnvOverrides::new();
        let response = AnthropicAdapter
            .dispatch_gateway(
                &context(SECRET),
                &call(&*transport, &NOOP_ATTACHMENT_STORE, &env),
                &gateway_request(),
                &DispatchOptions::default(),
            )
            .await
            .expect("dispatch");

        assert!(response.ok);
        assert_eq!(response.text, "Hello world", "`join('')` adds no separator");
        assert_eq!(response.model, "claude-sonnet-4-5-20250514");
        assert_eq!(response.provider, "anthropic");
        assert_eq!(response.error, None);
        assert_eq!(
            response.usage,
            Some(GatewayUsage {
                prompt_tokens: 12,
                completion_tokens: 5,
                total_tokens: 17,
            })
        );
        let calls = response.function_calls.expect("function calls");
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name, "get_weather");
        assert_eq!(calls[0].args, Some(json!({ "city": "Berlin" })));

        let seen = transport.seen.lock().expect("lock");
        assert_eq!(seen[0].url, "https://api.anthropic.com/v1/messages");
        assert_eq!(seen[0].method, http::Method::POST);
        assert_eq!(seen[0].headers.get("x-api-key").expect("key"), SECRET);
        assert_eq!(
            seen[0].headers.get("anthropic-version").expect("version"),
            "2023-06-01"
        );
        assert_eq!(
            seen[0].headers.get("content-type").expect("ctype"),
            "application/json"
        );
        assert_eq!(seen[0].timeout_ms, 60_000);
        assert_eq!(
            seen[0].body.as_deref().expect("body"),
            r#"{"model":"claude-sonnet-4-5","messages":[{"role":"user","content":[{"type":"text","text":"hello"}]},{"role":"assistant","content":"hi"},{"role":"user","content":[{"type":"text","text":"say more"}]}],"max_tokens":64,"system":"Be terse.\nAnswer in English.","temperature":0.25,"tools":[{"name":"get_weather","description":"Look up the weather","input_schema":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}]}"#
        );
    }

    /// The optional keys disappear when the request carries none, and `max_tokens`
    /// falls back to the `?? 4096` literal of `anthropic/index.ts:280`.
    #[tokio::test]
    async fn dispatch_gateway_omits_the_optional_keys() {
        let transport = StubTransport::new(HttpResponse::json(
            StatusCode::OK,
            &json!({ "content": [] }),
        ));
        let env = EnvOverrides::new();
        let response = AnthropicAdapter
            .dispatch_gateway(
                &context(SECRET),
                &call(&*transport, &NOOP_ATTACHMENT_STORE, &env),
                &GatewayRequest::new("claude-3-5-haiku-latest", vec![GatewayMessage::user("hi")]),
                &DispatchOptions::default(),
            )
            .await
            .expect("dispatch");

        assert!(response.ok);
        assert_eq!(response.text, "");
        assert_eq!(
            response.model, "claude-3-5-haiku-latest",
            "`json.model ?? request.model`"
        );
        assert_eq!(response.usage, None);
        assert_eq!(response.function_calls, None);
        assert_eq!(
            sent_body(&transport),
            r#"{"model":"claude-3-5-haiku-latest","messages":[{"role":"user","content":[{"type":"text","text":"hi"}]}],"max_tokens":4096}"#
        );
    }

    /// `??` is nullish, not falsy: `max_tokens: 0` and `temperature: 0.0` survive
    /// (`anthropic/index.ts:280` and `index.ts:287`), while an empty system join is
    /// still skipped by the falsy `if (systemMessages)` of `index.ts:283`.
    #[tokio::test]
    async fn zero_valued_options_survive_the_nullish_checks() {
        let transport = StubTransport::new(HttpResponse::json(
            StatusCode::OK,
            &json!({ "content": [] }),
        ));
        let env = EnvOverrides::new();
        let mut request = GatewayRequest::new("m", vec![GatewayMessage::user("hi")]);
        request.max_tokens = Some(0);
        request.temperature = Some(0.0);
        request
            .messages
            .insert(0, GatewayMessage::new(GatewayRole::System, ""));

        AnthropicAdapter
            .dispatch_gateway(
                &context(SECRET),
                &call(&*transport, &NOOP_ATTACHMENT_STORE, &env),
                &request,
                &DispatchOptions::default(),
            )
            .await
            .expect("dispatch");

        assert_eq!(
            sent_body(&transport),
            r#"{"model":"m","messages":[{"role":"user","content":[{"type":"text","text":"hi"}]}],"max_tokens":0,"temperature":0.0}"#
        );
    }

    /// A `tools` array whose entries are all unmappable emits no `tools` key at all —
    /// the second guard of `anthropic/index.ts:297`.
    #[tokio::test]
    async fn dispatch_gateway_omits_tools_that_cannot_be_mapped() {
        let transport = StubTransport::new(HttpResponse::json(
            StatusCode::OK,
            &json!({ "content": [] }),
        ));
        let env = EnvOverrides::new();
        let mut request = GatewayRequest::new("m", vec![GatewayMessage::user("hi")]);
        request.tools = Some(vec![json!({ "type": "web_search" }), json!(null)]);

        AnthropicAdapter
            .dispatch_gateway(
                &context(SECRET),
                &call(&*transport, &NOOP_ATTACHMENT_STORE, &env),
                &request,
                &DispatchOptions::default(),
            )
            .await
            .expect("dispatch");

        assert_eq!(
            sent_body(&transport),
            r#"{"model":"m","messages":[{"role":"user","content":[{"type":"text","text":"hi"}]}],"max_tokens":4096}"#
        );
    }

    /// A non-2xx answer reports `error.message` (`anthropic/index.ts:320-325`), with
    /// `text: ''` and the *request* model — `json.model` is never consulted here.
    #[tokio::test]
    async fn dispatch_gateway_reports_the_api_error_message() {
        let transport = StubTransport::new(HttpResponse::json(
            StatusCode::BAD_REQUEST,
            &json!({
                "type": "error",
                "error": {
                    "type": "invalid_request_error",
                    "message": "max_tokens: must be greater than or equal to 1"
                }
            }),
        ));
        let env = EnvOverrides::new();
        let response = AnthropicAdapter
            .dispatch_gateway(
                &context(SECRET),
                &call(&*transport, &NOOP_ATTACHMENT_STORE, &env),
                &GatewayRequest::new("claude-sonnet-4-5", vec![GatewayMessage::user("hi")]),
                &DispatchOptions::default(),
            )
            .await
            .expect("anthropic swallows the API error");

        assert!(!response.ok);
        assert_eq!(response.text, "");
        assert_eq!(response.model, "claude-sonnet-4-5");
        assert_eq!(response.provider, "anthropic");
        assert_eq!(response.usage, None);
        assert_eq!(
            response.error.as_deref(),
            Some("max_tokens: must be greater than or equal to 1")
        );
    }

    /// The inline fallbacks of `anthropic/index.ts:322-324` differ from the shared
    /// `parseErrorMessage`: a parsable body without `error.message` is used **verbatim**
    /// (never replaced by the status line), an unparsable body keeps its whitespace, an
    /// empty `error.message` wins over the raw body, and only an empty body falls back
    /// to `HTTP <status>` — without a reason phrase.
    #[tokio::test]
    async fn dispatch_gateway_falls_back_to_the_raw_body_and_then_the_status_line() {
        let cases = [
            (
                StatusCode::TOO_MANY_REQUESTS,
                r#"{"type":"error","error":{"type":"rate_limit_error"}}"#,
                r#"{"type":"error","error":{"type":"rate_limit_error"}}"#,
            ),
            (StatusCode::BAD_REQUEST, r#"{"error":{"message":""}}"#, ""),
            (
                StatusCode::BAD_GATEWAY,
                "  upstream died  ",
                "  upstream died  ",
            ),
            (StatusCode::INTERNAL_SERVER_ERROR, "", "HTTP 500"),
        ];

        for (status, body, expected) in cases {
            let transport = StubTransport::new(HttpResponse::new(status, HeaderMap::new(), body));
            let env = EnvOverrides::new();
            let response = AnthropicAdapter
                .dispatch_gateway(
                    &context(SECRET),
                    &call(&*transport, &NOOP_ATTACHMENT_STORE, &env),
                    &GatewayRequest::new("m", vec![GatewayMessage::user("hi")]),
                    &DispatchOptions::default(),
                )
                .await
                .expect("dispatch");

            assert!(!response.ok);
            assert_eq!(response.error.as_deref(), Some(expected), "{status} {body}");
        }
    }

    /// A `content` that is neither nullish nor an array makes the TypeScript throw
    /// `TypeError: json.content?.filter is not a function`; the `catch` turns it into a
    /// failed response (divergence 4). A *nullish* `content` is not an error.
    #[tokio::test]
    async fn dispatch_gateway_reports_a_non_array_content_as_the_type_error() {
        let failing =
            StubTransport::new(HttpResponse::json(StatusCode::OK, &json!({ "content": 5 })));
        let env = EnvOverrides::new();
        let response = AnthropicAdapter
            .dispatch_gateway(
                &context(SECRET),
                &call(&*failing, &NOOP_ATTACHMENT_STORE, &env),
                &GatewayRequest::new("m", vec![GatewayMessage::user("hi")]),
                &DispatchOptions::default(),
            )
            .await
            .expect("dispatch");
        assert!(!response.ok);
        assert_eq!(response.error.as_deref(), Some(TYPE_ERROR_MESSAGE));

        let nullish = StubTransport::new(HttpResponse::json(
            StatusCode::OK,
            &json!({ "content": null, "model": "m" }),
        ));
        let response = AnthropicAdapter
            .dispatch_gateway(
                &context(SECRET),
                &call(&*nullish, &NOOP_ATTACHMENT_STORE, &env),
                &GatewayRequest::new("m", vec![GatewayMessage::user("hi")]),
                &DispatchOptions::default(),
            )
            .await
            .expect("dispatch");
        assert!(response.ok);
        assert_eq!(response.text, "");
        assert_eq!(response.function_calls, None);
    }

    /// A reply that is not valid JSON is a failed response (`response.json()` rejects in
    /// TypeScript; divergence 5 changes only the message).
    #[tokio::test]
    async fn dispatch_gateway_reports_an_undecodable_body() {
        let transport = StubTransport::new(HttpResponse::text(StatusCode::OK, "<html>nope"));
        let env = EnvOverrides::new();
        let response = AnthropicAdapter
            .dispatch_gateway(
                &context(SECRET),
                &call(&*transport, &NOOP_ATTACHMENT_STORE, &env),
                &GatewayRequest::new("m", vec![GatewayMessage::user("hi")]),
                &DispatchOptions::default(),
            )
            .await
            .expect("dispatch");

        assert!(!response.ok);
        assert!(!response.error.expect("error").is_empty());
    }

    /// `'No valid messages to send'` (`anthropic/index.ts:266-274`): the check runs
    /// before the request is built, so a system-only conversation never calls the API.
    #[tokio::test]
    async fn dispatch_gateway_reports_no_valid_messages_without_a_request() {
        let transport = StubTransport::new(HttpResponse::json(StatusCode::OK, &json!({})));
        let env = EnvOverrides::new();
        let response = AnthropicAdapter
            .dispatch_gateway(
                &context(SECRET),
                &call(&*transport, &NOOP_ATTACHMENT_STORE, &env),
                &GatewayRequest::new(
                    "claude-sonnet-4-5",
                    vec![GatewayMessage::new(
                        GatewayRole::System,
                        "only a system prompt",
                    )],
                ),
                &DispatchOptions::default(),
            )
            .await
            .expect("dispatch");

        assert!(!response.ok);
        assert_eq!(response.error.as_deref(), Some(NO_VALID_MESSAGES));
        assert_eq!(response.model, "claude-sonnet-4-5");
        assert!(transport.seen.lock().expect("lock").is_empty());
    }

    /// `try { … } catch { }`: a transport failure becomes a failed response, never an
    /// `Err` (divergence 1).
    #[tokio::test]
    async fn dispatch_gateway_reports_a_transport_failure_as_a_failed_response() {
        let env = EnvOverrides::new();
        let response = AnthropicAdapter
            .dispatch_gateway(
                &context(SECRET),
                &call(&UnreachableTransport, &NOOP_ATTACHMENT_STORE, &env),
                &gateway_request(),
                &DispatchOptions::default(),
            )
            .await
            .expect("anthropic swallows the transport error");

        assert!(!response.ok);
        assert_eq!(
            response.error.as_deref(),
            Some("No HTTP transport is configured.")
        );
        assert_eq!(response.provider, "anthropic");
    }

    /// `options.signal` travels into `fetchWithTimeout` (`anthropic/index.ts:314`): a
    /// signal that already fired keeps the request from leaving the process and is
    /// reported as a failed response with the abort text (divergence 7).
    #[tokio::test]
    async fn dispatch_gateway_honours_the_abort_signal() {
        let transport = StubTransport::new(HttpResponse::json(
            StatusCode::OK,
            &json!({ "content": [] }),
        ));
        let env = EnvOverrides::new();
        let abort = AbortSignal::new();
        abort.abort();
        let response = AnthropicAdapter
            .dispatch_gateway(
                &context(SECRET),
                &call(&*transport, &NOOP_ATTACHMENT_STORE, &env),
                &gateway_request(),
                &DispatchOptions {
                    abort: Some(abort),
                    ..DispatchOptions::default()
                },
            )
            .await
            .expect("dispatch");

        assert!(!response.ok);
        assert_eq!(response.error.as_deref(), Some("The operation was aborted"));
        assert!(transport.seen.lock().expect("lock").is_empty());
    }

    /// `testConnectivity` on the happy path: `POST /v1/messages` with the ping body of
    /// `anthropic/index.ts:243-247`, the catalog default model included, and the
    /// constant success message.
    #[tokio::test]
    async fn test_connectivity_verifies_on_a_ping() {
        let transport = StubTransport::new(HttpResponse::json(
            StatusCode::OK,
            &json!({ "content": [{ "type": "text", "text": "pong" }] }),
        ));
        let env = EnvOverrides::new();
        let result = AnthropicAdapter
            .test_connectivity(
                &context(SECRET),
                &call(&*transport, &NOOP_ATTACHMENT_STORE, &env),
                None,
            )
            .await;

        assert!(result.ok);
        assert_eq!(result.message, CONNECTIVITY_OK);
        assert_eq!(result.rate_limits, None);

        let seen = transport.seen.lock().expect("lock");
        assert_eq!(seen[0].url, "https://api.anthropic.com/v1/messages");
        assert_eq!(seen[0].method, http::Method::POST);
        assert_eq!(seen[0].headers.get("x-api-key").expect("key"), SECRET);
        assert_eq!(
            seen[0].headers.get("anthropic-version").expect("version"),
            "2023-06-01"
        );
        assert_eq!(
            seen[0].headers.get("content-type").expect("ctype"),
            "application/json"
        );
        // `fetchJsonOk(url, init)` without a timeout argument: the 15 s default.
        assert_eq!(seen[0].timeout_ms, 15_000);
        assert_eq!(
            seen[0].body.as_deref().expect("body"),
            r#"{"model":"claude-sonnet-4-5","max_tokens":4,"messages":[{"role":"user","content":"ping"}]}"#
        );
    }

    /// A 2xx answer verifies even without `content`, because `fetchJsonOk` only looks at
    /// the payload's shape for the JSON branch — and an explicit model overrides the
    /// catalog default.
    #[tokio::test]
    async fn test_connectivity_accepts_a_payload_without_content() {
        let transport = StubTransport::new(HttpResponse::json(StatusCode::OK, &json!({})));
        let env = EnvOverrides::new();
        let result = AnthropicAdapter
            .test_connectivity(
                &context(SECRET),
                &call(&*transport, &NOOP_ATTACHMENT_STORE, &env),
                Some("claude-3-opus-latest"),
            )
            .await;

        assert!(result.ok);
        assert_eq!(result.message, CONNECTIVITY_OK);
        assert_eq!(
            sent_body(&transport),
            r#"{"model":"claude-3-opus-latest","max_tokens":4,"messages":[{"role":"user","content":"ping"}]}"#
        );
    }

    /// `'Anthropic test requires a model id.'` (`anthropic/index.ts:232-234`): an empty
    /// `options.model` falls through to an empty `defaultModels`, and no request is sent.
    #[tokio::test]
    async fn test_connectivity_requires_a_model_id() {
        let transport = StubTransport::new(HttpResponse::json(StatusCode::OK, &json!({})));
        let env = EnvOverrides::new();
        let context = context_without_default_models();

        for model in [None, Some("")] {
            let result = AnthropicAdapter
                .test_connectivity(
                    &context,
                    &call(&*transport, &NOOP_ATTACHMENT_STORE, &env),
                    model,
                )
                .await;
            assert!(!result.ok);
            assert_eq!(result.message, MISSING_MODEL_MESSAGE);
        }
        assert!(transport.seen.lock().expect("lock").is_empty());
    }

    /// A non-2xx answer reports the shared `parseErrorMessage` text behind the
    /// `'Anthropic connectivity failed: '` prefix (`anthropic/index.ts:250-252`).
    #[tokio::test]
    async fn test_connectivity_reports_a_failed_status() {
        let transport = StubTransport::new(HttpResponse::json(
            StatusCode::UNAUTHORIZED,
            &json!({
                "type": "error",
                "error": { "type": "authentication_error", "message": "invalid x-api-key" }
            }),
        ));
        let env = EnvOverrides::new();
        let result = AnthropicAdapter
            .test_connectivity(
                &context(SECRET),
                &call(&*transport, &NOOP_ATTACHMENT_STORE, &env),
                None,
            )
            .await;

        assert!(!result.ok);
        assert_eq!(
            result.message,
            "Anthropic connectivity failed: invalid x-api-key"
        );
        assert_eq!(result.rate_limits, None);
    }

    /// A transport failure is the `catch` branch of `fetchJsonOk`: the message is the
    /// error text, prefixed like a failed status.
    #[tokio::test]
    async fn test_connectivity_reports_a_transport_failure() {
        let env = EnvOverrides::new();
        let result = AnthropicAdapter
            .test_connectivity(
                &context(SECRET),
                &call(&UnreachableTransport, &NOOP_ATTACHMENT_STORE, &env),
                None,
            )
            .await;

        assert!(!result.ok);
        assert_eq!(
            result.message,
            "Anthropic connectivity failed: No HTTP transport is configured."
        );
    }
}
