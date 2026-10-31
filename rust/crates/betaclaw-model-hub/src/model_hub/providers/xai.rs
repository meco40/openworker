//! Port of `src/server/model-hub/Models/xai/index.ts`.
//!
//! # Why there is no SDK-to-REST translation
//!
//! xAI ships an official SDK, but `xai/index.ts` never imports it: both requests
//! are built by hand and sent through the shared `fetchWithTimeout` / `fetchJsonOk`
//! helpers, exactly like the Anthropic adapter. Nothing has to be translated, so
//! the port speaks the identical REST surface:
//!
//! | TypeScript | REST |
//! | --- | --- |
//! | `fetchWithTimeout(`${XAI_BASE_URL}/models`, { method: 'GET' }, …)` (`index.ts:324-327`) | `GET https://api.x.ai/v1/models` with `authorization: Bearer <secret>` |
//! | `fetchJsonOk(`${XAI_BASE_URL}/models`, …)` (`index.ts:345-348`) | the same endpoint, shared 15 s default timeout |
//! | `fetchWithTimeout(`${XAI_BASE_URL}/responses`, …, timeoutMs, options?.signal)` (`index.ts:405-417`) | `POST https://api.x.ai/v1/responses`, `content-type: application/json`, `authorization: Bearer <secret>` |
//!
//! `/responses` is xAI's *Responses* API — the endpoint that takes an `input`
//! array and answers with `output` items — not its Chat Completions API. The body
//! therefore carries `max_output_tokens` and `text.format` where Chat Completions
//! would use `max_tokens` and `response_format` (`index.ts:379-386`).
//!
//! `XAI_BASE_URL = 'https://api.x.ai/v1'` (`index.ts:63`) is the `apiBaseUrl` of
//! the `xai-native` catalog entry, and the port keeps that literal instead of
//! reading `context.provider.api_base_url`, exactly like the TypeScript does.
//!
//! | Rust item | TypeScript |
//! | --- | --- |
//! | [`API_BASE_URL`], [`models_url`], [`responses_url`] | `index.ts:63`, `index.ts:324`, `index.ts:405` |
//! | [`map_response_format`] | `index.ts:65-87` |
//! | [`is_image_attachment`], [`is_text_attachment`] (re-used) | `index.ts:89-96` |
//! | [`read_text_attachment_snippet`], [`read_stored_attachment_as_data_url`] (re-used) | `index.ts:98-110`, `index.ts:166` |
//! | [`build_xai_input_messages`] | `index.ts:112-212` |
//! | [`map_openai_tool_to_xai`] | `index.ts:214-257` |
//! | [`extract_xai_function_calls`] | `index.ts:259-290` |
//! | [`extract_text_from_xai_output`] | `index.ts:292-318` |
//! | [`parse_models`], [`resolve_model_list`] | `fetchModels`, `index.ts:323-342` |
//! | [`CONNECTIVITY_OK`], [`CONNECTIVITY_FAILED_PREFIX`] | `testConnectivity`, `index.ts:344-353` |
//! | [`NO_VALID_MESSAGES`], [`build_gateway_body`], [`dispatch_timeout_ms`] | `dispatchGateway`, `index.ts:355-403` |
//! | [`error_message_for_failed_response`] | the inline error branch, `index.ts:419-442` |
//! | [`resolve_output_items`], [`extract_xai_usage`], [`extract_xai_model`] | `index.ts:444-466` |
//! | [`XaiAdapter`] | `xAIProviderAdapter`, `index.ts:320-478` |
//!
//! # Deliberate divergences
//!
//! 1. **`dispatchGateway` swallows everything.** `index.ts:356-477` wraps the whole
//!    body in `try { … } catch { }` and turns *any* failure — a transport error, an
//!    unparsable body, the `TypeError` of divergence 7 — into `{ ok: false, error }`.
//!    [`XaiAdapter::dispatch_gateway`] therefore always returns `Ok` and reports
//!    every failure as [`GatewayResponse::failure`]; the `Err` variant of its return
//!    type is never produced. This matches Gemini and Anthropic and differs from the
//!    shared OpenAI-compatible layer, which lets a transport error escape.
//! 2. **`fetchModels` and `testConnectivity` swallow nothing.** `index.ts:323-342`
//!    has no `try`/`catch`, so a transport failure and an undecodable body reject
//!    ([`HttpError`]) instead of degrading to an empty list; `testConnectivity` goes
//!    through `fetchJsonOk`, which converts every failure into its
//!    `{ ok: false, message }` shape.
//! 3. **The error branch is not the shared `parseErrorMessage`.** `index.ts:419-442`
//!    extracts the message itself, with a precedence that differs from
//!    `http.ts:50-69`: only `error` as a string (an *empty* string is accepted and
//!    wins over `error.message`), then `error.message` as a string, and otherwise
//!    the raw body used verbatim and **untrimmed**, or `` `HTTP ${status}` `` for an
//!    empty body. There is no top-level `message` lookup and no reason phrase.
//! 4. **Thrown property accesses are reproduced.** Two response shapes make the
//!    TypeScript throw: `json.data` on a body that parsed to `null` and a
//!    non-nullish, non-array `data` (`index.ts:335`, through `(json.data ?? []).map`).
//!    Both V8 messages were verified with `node` and are reported as
//!    [`HttpError::InvalidBody`], because the rejection escapes `fetchModels`
//!    (divergence 2). A *missing or null* `data` is not an error: `??` and `.map`
//!    make it an empty list, which the port also returns.
//! 5. **Parse-error text.** `await response.json()` failing rejects with a V8
//!    `SyntaxError` (`Unexpected token '<', "<html>" is not valid JSON`). The port
//!    reports the `serde_json` error text instead. Both paths yield the same
//!    `{ ok: false }` shape; only the message differs.
//! 6. **Non-string JSON scalars.** `json_schema.name` is typed as a string but
//!    `String(value)` coerces whatever is there, so the port coerces the same way (an
//!    object becoming its JSON text where JS prints `[object Object]`), while a
//!    non-string `json.model` falls back to `request.model` instead of being copied
//!    into a `String` field (`index.ts:456`).
//! 7. **A non-array `output`.** `for (const item of output)` iterates a *string* code
//!    point by code point, and every code point then fails the
//!    `typeof item === 'object'` guard of both extractors, so a string is equivalent
//!    to an empty list. Any other non-nullish value throws
//!    `TypeError: output is not iterable`, which the `catch` turns into
//!    `{ ok: false }`; [`resolve_output_items`] reports exactly that message
//!    (verified with `node`).
//! 8. **Usage presence and token counts.** `json.usage ? …` (`index.ts:459`) is a
//!    truthiness test, so `null`, `0`, `false` and `""` all mean "no usage" while
//!    `{}` yields three zeros. The three counts are `?? 0`-ed and read as `i64`, so a
//!    fractional count becomes `0` where TypeScript would keep the float; unlike
//!    Anthropic, `total_tokens` is read from the response and is **not** the sum of
//!    the other two.
//! 9. **Attachments arrive through a seam.** `readStoredAttachmentAsDataUrl`
//!    (`index.ts:166`) and `readStoredAttachmentBuffer` (`index.ts:102`) read from
//!    the persona-scoped attachment root. That path resolution belongs to the
//!    channels slice, so it is the injected [`AttachmentStore`] from
//!    `openai_compatible::utils`, exactly as in `request/build.ts`. The three local
//!    helpers of `index.ts:89-110` are byte-identical to their namesakes in
//!    `shared/openai-compatible/utils.ts`, so the shared ones are re-used instead of
//!    duplicated.
//! 10. **No streaming.** `dispatchGateway` never sets `stream`, never asks for an SSE
//!     body and never calls `options.onStreamDelta`.
//!     [`DispatchOptions::on_stream_delta`] is therefore ignored, as the TypeScript
//!     ignores it.
//! 11. **No rate limits.** Nothing in `xai/index.ts` reads a rate-limit header, so
//!     `ConnectivityResult::rate_limits` and `GatewayResponse::rate_limits` stay
//!     `None` here and in TypeScript.
//! 12. **Abort text.** A caller signal that fires makes Node reject with
//!     `AbortError: This operation was aborted`; [`HttpError::Aborted`] renders as
//!     `The operation was aborted`. The failure path itself is identical — the port
//!     never returns `Err` from `dispatch_gateway` (divergence 1).
//! 13. **`String.prototype.trim` is not `str::trim`.** JavaScript also strips U+FEFF,
//!     which Rust's Unicode `White_Space` class does not. It affects
//!     `message.content.trim()` (`index.ts:156`), the tool-name trim of
//!     `index.ts:233-234` and the final `texts.join('').trim()` of `index.ts:317`.
//! 14. **The timeout is resolved through the environment seam.** `index.ts:358-360`
//!     calls `resolveModelHubGatewayTimeoutMs`, which reads `process.env` at call
//!     time; [`dispatch_timeout_ms`] reads the same two variables through
//!     [`EnvOverrides`], which falls through to the process environment when nothing
//!     is pinned. The behaviour is identical — the tests just stop depending on the
//!     ambient environment.

use serde_json::{json, Map, Value};

use crate::model_hub::env::EnvOverrides;
use crate::model_hub::http::{
    fetch_json_ok, fetch_with_timeout, resolve_model_hub_gateway_timeout_ms_with, BoxFuture,
    HttpError, HttpRequest, HttpResponse, JsonOkResult, DEFAULT_REQUEST_TIMEOUT_MS,
};
use crate::model_hub::openai_compatible::utils::{
    is_image_attachment, is_text_attachment, read_stored_attachment_as_data_url,
    read_text_attachment_snippet, AttachmentStore,
};
use crate::model_hub::openai_compatible::DispatchOptions;
use crate::model_hub::types::{
    ConnectivityResult, FetchedModel, GatewayFunctionCall, GatewayMessage, GatewayRequest,
    GatewayResponse, GatewayRole, GatewayUsage, ProviderExecutionContext,
};

use super::{ProviderAdapter, ProviderCall};

/// `XAI_BASE_URL` from `xai/index.ts:63`.
pub const API_BASE_URL: &str = "https://api.x.ai/v1";

/// `'xAI connectivity verified (models list reachable).'` from `xai/index.ts:351`.
pub const CONNECTIVITY_OK: &str = "xAI connectivity verified (models list reachable).";
/// The prefix of `` `xAI connectivity failed: ${result.message}` ``
/// (`xai/index.ts:352`).
pub const CONNECTIVITY_FAILED_PREFIX: &str = "xAI connectivity failed: ";

/// `'No valid messages to send'` from `xai/index.ts:368`.
pub const NO_VALID_MESSAGES: &str = "No valid messages to send";

/// `TypeError: Cannot read properties of null (reading 'data')` — `json.data` on a
/// body that parsed to `null` (`xai/index.ts:335`, divergence 4).
pub const NULL_DOCUMENT_MESSAGE: &str = "Cannot read properties of null (reading 'data')";
/// `TypeError: (json.data ?? []).map is not a function` — a `data` that is neither
/// nullish nor an array (`xai/index.ts:335`, divergence 4).
///
/// V8 prints the *source text* of the callee, so the `??` fallback stays in the
/// message. Verified with `node`.
pub const DATA_TYPE_ERROR_MESSAGE: &str = "(json.data ?? []).map is not a function";
/// `TypeError: output is not iterable` — the `for (const item of output)` of
/// `xai/index.ts:262` and `xai/index.ts:295` over a non-nullish non-array
/// (divergence 7). V8 names the iterated binding, which is `output` in both loops.
pub const NOT_ITERABLE_MESSAGE: &str = "output is not iterable";

/// `` `${XAI_BASE_URL}/models` `` — `index.ts:324` and `index.ts:345`.
///
/// The secret travels in the `authorization` header, so there is no query string to
/// build and no `encodeURIComponent` helper like the Gemini adapter has.
pub fn models_url() -> String {
    format!("{API_BASE_URL}/models")
}

/// `` `${XAI_BASE_URL}/responses` `` — `index.ts:406`.
pub fn responses_url() -> String {
    format!("{API_BASE_URL}/responses")
}

/// `resolveModelHubGatewayTimeoutMs({ hasTools })` from `shared/http.ts:13-27`,
/// called as `index.ts:358-360` does.
///
/// `has_tools` is `Array.isArray(request.tools) && request.tools.length > 0`
/// (`index.ts:359`). With nothing pinned, [`EnvOverrides::get`] reads `process.env`
/// exactly like the TypeScript (divergence 14).
pub fn dispatch_timeout_ms(has_tools: bool, env: &EnvOverrides) -> u64 {
    resolve_model_hub_gateway_timeout_ms_with(
        has_tools,
        env.get("MODEL_HUB_GATEWAY_TIMEOUT_MS").as_deref(),
        env.get("MODEL_HUB_GATEWAY_EXEC_TIMEOUT_MS").as_deref(),
    )
}

/// `Array.isArray(request.tools) && request.tools.length > 0` (`index.ts:359`).
fn has_tools(request: &GatewayRequest) -> bool {
    request
        .tools
        .as_ref()
        .is_some_and(|tools| !tools.is_empty())
}

/// JavaScript truthiness of a JSON value: `false`, `0`, `""` and `null` are falsy,
/// everything else — including `[]` and `{}` — is truthy.
///
/// Needed by the `if (value && …)` guard of `mapResponseFormat` (`index.ts:69`), the
/// `typed.json_schema?.name` / `.schema` tests of `index.ts:76` and the
/// `json.usage ? …` test of `index.ts:459`.
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
/// Used by `String(typed.json_schema.name)` (`index.ts:79`). Scalars stringify
/// identically in both languages; an object or array is serialised as JSON here
/// where JS would print `[object Object]` (divergence 6).
fn js_string_value(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => serde_json::to_string(other).unwrap_or_default(),
    }
}

/// `mapResponseFormat` from `xai/index.ts:65-87`.
///
/// The result is nested one level deeper in the request body as `text: { format }`
/// by [`build_gateway_body`], matching `index.ts:386`.
///
/// `typed.type === 'json_object'` wins first and returns a fresh one-key object, so a
/// `json_schema` payload that also carries `json_object` details loses them.
/// `json_schema` requires both a truthy `name` and a truthy `schema`; `strict`
/// defaults to `true` and only an explicit `false` turns it off
/// (`typed.json_schema.strict !== false`). When nothing matched, only
/// `responseMimeType === 'application/json'` still produces `{ "type": "json_object" }`.
pub fn map_response_format(
    value: Option<&Value>,
    response_mime_type: Option<&str>,
) -> Option<Value> {
    if let Some(object) = value.and_then(Value::as_object) {
        match object.get("type").and_then(Value::as_str) {
            Some("json_object") => return Some(json!({ "type": "json_object" })),
            Some("json_schema") => {
                if let Some(json_schema) = object.get("json_schema").and_then(Value::as_object) {
                    let name = json_schema
                        .get("name")
                        .filter(|value| is_truthy(value))
                        .map(js_string_value);
                    let schema = json_schema.get("schema").filter(|value| is_truthy(value));
                    if let (Some(name), Some(schema)) = (name, schema) {
                        let mut format = Map::new();
                        format.insert("type".to_string(), Value::from("json_schema"));
                        format.insert("name".to_string(), Value::from(name));
                        format.insert("schema".to_string(), schema.clone());
                        format.insert(
                            "strict".to_string(),
                            Value::from(!matches!(
                                json_schema.get("strict"),
                                Some(Value::Bool(false))
                            )),
                        );
                        return Some(Value::Object(format));
                    }
                }
            }
            _ => {}
        }
    }

    (response_mime_type == Some("application/json")).then(|| json!({ "type": "json_object" }))
}

/// `buildXAIInputMessages` from `xai/index.ts:112-212`.
///
/// Every message produces exactly one entry, so the result is empty only for an
/// empty conversation — `dispatchGateway` uses that as its `No valid messages to
/// send` short-circuit (`index.ts:362-370`).
///
/// `system` and `assistant` turns keep their plain string content. A `user` turn
/// without attachments does too; with attachments it becomes a `content` *array*:
///
/// - an image attachment of the **latest** user message that carries attachments is
///   inlined as `{ type: 'image_url', image_url: { url: <data URL> } }`, and the text
///   collected so far is flushed as one `{ type: 'text' }` part first;
/// - a text attachment of that same message contributes
///   `` `Attachment ${name} (${mimeType}):\n${snippet}` `` to the running text;
/// - everything else — a binary attachment of an older message, a missing file, an
///   empty file — degrades to `` `[Attachment: ${name} (${mimeType}, ${size} bytes)]` ``.
///
/// Text parts are joined with a blank line (`textParts.join('\n\n')`) whenever they
/// are flushed.
pub fn build_xai_input_messages(
    store: &dyn AttachmentStore,
    messages: &[GatewayMessage],
) -> Vec<Value> {
    let mut result: Vec<Value> = Vec::new();

    // `latestUserAttachmentIndex` (`index.ts:116-123`): the *last* user message with
    // at least one attachment, or nothing (`-1`, which no iteration index equals).
    let latest_user_attachment_index = messages
        .iter()
        .enumerate()
        .rev()
        .find(|(_, message)| message.role == GatewayRole::User && !message.attachments().is_empty())
        .map(|(index, _)| index);

    for (index, message) in messages.iter().enumerate() {
        let attachments = message.attachments();

        match message.role {
            GatewayRole::System => {
                result.push(string_content_message("system", &message.content));
                continue;
            }
            GatewayRole::Assistant => {
                result.push(string_content_message("assistant", &message.content));
                continue;
            }
            GatewayRole::User => {}
        }

        if attachments.is_empty() {
            result.push(string_content_message("user", &message.content));
            continue;
        }

        let mut content_parts: Vec<Value> = Vec::new();
        let mut text_parts: Vec<String> = Vec::new();
        let trimmed_content = message.content.trim();
        if !trimmed_content.is_empty() {
            text_parts.push(trimmed_content.to_string());
        }

        let include_binary_attachments = latest_user_attachment_index == Some(index);

        for attachment in attachments {
            if include_binary_attachments && is_image_attachment(&attachment.mime_type) {
                if let Some(data_url) = read_stored_attachment_as_data_url(store, attachment) {
                    // Flush the text parts first (`index.ts:168-175`).
                    if !text_parts.is_empty() {
                        content_parts.push(text_part(&text_parts.join("\n\n")));
                        text_parts.clear();
                    }
                    content_parts.push(image_part(&data_url));
                    continue;
                }
            }

            if include_binary_attachments && is_text_attachment(&attachment.mime_type) {
                if let Some(snippet) = read_text_attachment_snippet(store, attachment) {
                    text_parts.push(format!(
                        "Attachment {} ({}):\n{}",
                        attachment.name, attachment.mime_type, snippet
                    ));
                    continue;
                }
            }

            text_parts.push(format!(
                "[Attachment: {} ({}, {} bytes)]",
                attachment.name, attachment.mime_type, attachment.size
            ));
        }

        // Add the remaining text parts (`index.ts:197-203`).
        if !text_parts.is_empty() {
            content_parts.push(text_part(&text_parts.join("\n\n")));
        }

        result.push(content_array_message(&content_parts));
    }

    result
}

/// `{ role, content }` with a plain string `content` (`index.ts:129-149`).
fn string_content_message(role: &str, content: &str) -> Value {
    let mut message = Map::new();
    message.insert("role".to_string(), Value::from(role));
    message.insert("content".to_string(), Value::from(content));
    Value::Object(message)
}

/// `{ role: 'user', content: <parts> }` (`index.ts:205-208`).
fn content_array_message(content_parts: &[Value]) -> Value {
    let mut message = Map::new();
    message.insert("role".to_string(), Value::from("user"));
    message.insert("content".to_string(), Value::Array(content_parts.to_vec()));
    Value::Object(message)
}

/// `{ type: 'text', text }` — the `contentParts` element of `index.ts:170-173` and
/// `index.ts:199-202`.
fn text_part(text: &str) -> Value {
    let mut part = Map::new();
    part.insert("type".to_string(), Value::from("text"));
    part.insert("text".to_string(), Value::from(text));
    Value::Object(part)
}

/// `{ type: 'image_url', image_url: { url: <data URL> } }` (`index.ts:176-179`).
fn image_part(data_url: &str) -> Value {
    let mut image_url = Map::new();
    image_url.insert("url".to_string(), Value::from(data_url));
    let mut part = Map::new();
    part.insert("type".to_string(), Value::from("image_url"));
    part.insert("image_url".to_string(), Value::Object(image_url));
    Value::Object(part)
}

/// `mapOpenAIToolToXAI` from `xai/index.ts:214-257`.
///
/// `None` for everything the source drops: a non-object, an array, a `type` that is
/// not the string `'function'`, and a missing or empty name after trimming.
///
/// Only a **direct** `type: 'function'` counts — unlike the shared OpenAI-compatible
/// mapper this one does not fall back on `tool.function.type`. A name is taken from
/// the top-level `name` first and only then from `function.name` (the `||` test, so
/// an empty trimmed name falls through). `description`, `parameters` and `strict`
/// each prefer the top-level key and fall back to the nested one with `??`, which
/// reacts to `null` only: an empty description survives, while `parameters: null`
/// still falls through. Absent keys are omitted from the result, exactly as
/// `JSON.stringify` drops `undefined` values.
pub fn map_openai_tool_to_xai(raw_tool: &Value) -> Option<Value> {
    let tool = raw_tool.as_object()?;

    if tool.get("type").and_then(Value::as_str) != Some("function") {
        return None;
    }

    let nested = tool.get("function").and_then(Value::as_object);

    let direct_name = tool
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    let nested_name = nested
        .and_then(|function| function.get("name"))
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    let name = if direct_name.is_empty() {
        nested_name
    } else {
        direct_name
    };
    if name.is_empty() {
        return None;
    }

    let description = tool.get("description").and_then(Value::as_str).or_else(|| {
        nested
            .and_then(|function| function.get("description"))
            .and_then(Value::as_str)
    });

    let parameters = tool
        .get("parameters")
        .filter(|value| !value.is_null())
        .or_else(|| {
            nested
                .and_then(|function| function.get("parameters"))
                .filter(|value| !value.is_null())
        });

    let strict = tool.get("strict").and_then(Value::as_bool).or_else(|| {
        nested
            .and_then(|function| function.get("strict"))
            .and_then(Value::as_bool)
    });

    let mut mapped = Map::new();
    mapped.insert("type".to_string(), Value::from("function"));
    mapped.insert("name".to_string(), Value::from(name));
    if let Some(description) = description {
        mapped.insert("description".to_string(), Value::from(description));
    }
    if let Some(parameters) = parameters {
        mapped.insert("parameters".to_string(), parameters.clone());
    }
    if let Some(strict) = strict {
        mapped.insert("strict".to_string(), Value::from(strict));
    }
    Some(Value::Object(mapped))
}

/// `extractXAIFunctionCalls` from `xai/index.ts:259-290`.
///
/// Only an object item whose `type` is exactly `'function_call'` and whose `name` is
/// a string contributes a call — an empty name included, because the source tests
/// `typeof … === 'string'`.
///
/// `arguments` is interpreted in three ways, in this order:
///
/// 1. a string is `JSON.parse`d, and an unparsable string becomes
///    `{ raw: <the original string> }` — the `try`/`catch` of `index.ts:276-280`;
/// 2. a truthy object — which in JavaScript includes an **array** — is copied
///    verbatim;
/// 3. anything else leaves `args` unset (`None`), so `JSON.stringify` omits the key
///    where TypeScript has `{ name }`.
pub fn extract_xai_function_calls(output: &[Value]) -> Vec<GatewayFunctionCall> {
    let mut calls = Vec::new();

    for item in output {
        let Some(typed_item) = item.as_object() else {
            continue;
        };
        if typed_item.get("type").and_then(Value::as_str) != Some("function_call") {
            continue;
        }
        let Some(name) = typed_item.get("name").and_then(Value::as_str) else {
            continue;
        };

        let args = match typed_item.get("arguments") {
            Some(Value::String(raw_args)) => Some(
                serde_json::from_str::<Value>(raw_args)
                    .unwrap_or_else(|_| json!({ "raw": raw_args.clone() })),
            ),
            Some(value) if value.is_object() || value.is_array() => Some(value.clone()),
            _ => None,
        };

        calls.push(GatewayFunctionCall {
            name: name.to_string(),
            args,
        });
    }

    calls
}

/// `extractTextFromXAIOutput` from `xai/index.ts:292-318`.
///
/// Only a `message` item whose `content` is an array contributes, and within it only
/// the `output_text` parts whose `text` is a **string** — a non-string `text` is
/// skipped rather than coerced, because the source tests `typeof … === 'string'`.
/// The parts are concatenated without a separator and the result is trimmed once at
/// the end, so interleaved whitespace-only parts disappear.
pub fn extract_text_from_xai_output(output: &[Value]) -> String {
    let mut text = String::new();

    for item in output {
        let Some(typed_item) = item.as_object() else {
            continue;
        };
        if typed_item.get("type").and_then(Value::as_str) != Some("message") {
            continue;
        }
        let Some(content) = typed_item.get("content").and_then(Value::as_array) else {
            continue;
        };
        for content_item in content {
            let Some(typed_content) = content_item.as_object() else {
                continue;
            };
            if typed_content.get("type").and_then(Value::as_str) != Some("output_text") {
                continue;
            }
            if let Some(part) = typed_content.get("text").and_then(Value::as_str) {
                text.push_str(part);
            }
        }
    }

    text.trim().to_string()
}

/// `json.output ?? []` plus the `for (const item of output)` iteration of
/// `xai/index.ts:450-451`.
///
/// A missing or `null` `output` yields an empty list (`??` substitutes). A string is
/// iterable in JavaScript, but every code point fails the `typeof item === 'object'`
/// guard of both extractors, so it is equivalent to an empty list. Any other
/// non-nullish value throws the `TypeError` of divergence 7, which the `catch` of
/// `index.ts:467-476` turns into a failed response.
pub fn resolve_output_items(json: &Value) -> Result<Vec<Value>, String> {
    match json.get("output") {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Array(items)) => Ok(items.clone()),
        Some(Value::String(_)) => Ok(Vec::new()),
        Some(_) => Err(NOT_ITERABLE_MESSAGE.to_string()),
    }
}

/// `json.data ?? []` typed as a list, plus the two property accesses of
/// `xai/index.ts:335` that can throw (divergence 4).
///
/// `fetchModels` has no `try`/`catch`, so both become an [`HttpError::InvalidBody`]
/// rejection with the V8 message text.
pub fn resolve_model_list(json: &Value) -> Result<Vec<Value>, String> {
    if json.is_null() {
        return Err(NULL_DOCUMENT_MESSAGE.to_string());
    }
    match json.get("data") {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Array(models)) => Ok(models.clone()),
        Some(_) => Err(DATA_TYPE_ERROR_MESSAGE.to_string()),
    }
}

/// The `(json.data ?? []).map((model) => ({ … }))` of `xai/index.ts:335-341`.
///
/// `name` echoes `id`, `provider` is the adapter id, and `owned_by`/`created` are
/// copied when they are of the documented type. `context_window` and `billing` are
/// not part of the mapping and stay unset.
///
/// Divergence: an entry whose `id` is not a string is *dropped*. TypeScript copies
/// `undefined` into the field, which the `FetchedModel` contract (`id: string`)
/// forbids, so there is no faithful target for it.
pub fn parse_models(json: &Value, provider_id: &str) -> Result<Vec<FetchedModel>, HttpError> {
    let models = resolve_model_list(json).map_err(HttpError::InvalidBody)?;
    Ok(models
        .iter()
        .filter_map(|model| {
            let id = model.get("id").and_then(Value::as_str)?;
            Some(FetchedModel {
                id: id.to_string(),
                name: id.to_string(),
                provider: provider_id.to_string(),
                owned_by: model
                    .get("owned_by")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                context_window: None,
                created: model.get("created").and_then(Value::as_f64),
                billing: None,
            })
        })
        .collect())
}

/// The `POST /v1/responses` body of `dispatchGateway` (`xai/index.ts:373-403`).
///
/// Key order follows the source — `model`, `input`, `store`, then the optional
/// `max_output_tokens`, `text`, `temperature`, `tools`, `tool_choice` and
/// `parallel_tool_calls` — so the serialised body is byte-comparable with
/// `JSON.stringify` of the TypeScript object (`serde_json` is built with
/// `preserve_order`).
///
/// `if (request.max_tokens)` is a truthiness test, so an explicit `0` is skipped,
/// while `temperature` is guarded by `!== undefined` and therefore keeps `0.0`. The
/// tool list is only emitted when the mapped result is non-empty, and then always
/// sets `tool_choice: 'auto'` and `parallel_tool_calls: true`.
///
/// `input` is passed in already built, because `dispatchGateway` short-circuits on an
/// empty one before any body exists (`index.ts:362-370`).
pub fn build_gateway_body(request: &GatewayRequest, input: Vec<Value>) -> Value {
    let mut body = Map::new();
    body.insert("model".to_string(), Value::from(request.model.clone()));
    body.insert("input".to_string(), Value::Array(input));
    body.insert("store".to_string(), Value::from(false));

    // `xAI's native Responses API names this field max_output_tokens; max_tokens is
    // only valid on its Chat Completions endpoint.` (`index.ts:380-381`).
    if let Some(max_tokens) = request.max_tokens.filter(|value| *value != 0) {
        body.insert("max_output_tokens".to_string(), Value::from(max_tokens));
    }

    if let Some(format) = map_response_format(
        request.response_format.as_ref(),
        request.response_mime_type.as_deref(),
    ) {
        let mut text = Map::new();
        text.insert("format".to_string(), format);
        body.insert("text".to_string(), Value::Object(text));
    }

    if let Some(temperature) = request.temperature {
        body.insert("temperature".to_string(), Value::from(temperature));
    }

    if let Some(tools) = request.tools.as_ref().filter(|tools| !tools.is_empty()) {
        let tools: Vec<Value> = tools.iter().filter_map(map_openai_tool_to_xai).collect();
        if !tools.is_empty() {
            body.insert("tools".to_string(), Value::Array(tools));
            body.insert("tool_choice".to_string(), Value::from("auto"));
            body.insert("parallel_tool_calls".to_string(), Value::from(true));
        }
    }

    Value::Object(body)
}

/// The inline error branch of `xai/index.ts:419-442`.
///
/// Transcribing the `try`/`catch` around `JSON.parse(errorText)`:
///
/// 1. an unparsable body (and a body that parsed to `null`, whose `errorJson.error`
///    throws) falls back to `errorText || `HTTP ${status}``: the raw, **untrimmed**
///    body for anything but the empty string, and otherwise the `` `HTTP ${status}` ``
///    literal — no reason phrase, unlike
///    [`parse_error_message`](crate::model_hub::http::parse_error_message);
/// 2. a parsable body whose `error` is a string returns it verbatim, an *empty*
///    string included (`typeof … === 'string'` is not a truthiness test);
/// 3. otherwise `error.message` is returned when it is a string, again empty strings
///    included;
/// 4. otherwise the same fallback as (1).
pub fn error_message_for_failed_response(response: &HttpResponse) -> String {
    let error_text = response.body.as_str();
    let fallback = || {
        if error_text.is_empty() {
            format!("HTTP {}", response.status.as_u16())
        } else {
            error_text.to_string()
        }
    };

    let Ok(json) = serde_json::from_str::<Value>(error_text) else {
        return fallback();
    };
    if json.is_null() {
        return fallback();
    }
    if let Some(error) = json.get("error") {
        if let Some(message) = error.as_str() {
            return message.to_string();
        }
        if let Some(message) = error.get("message").and_then(Value::as_str) {
            return message.to_string();
        }
    }
    fallback()
}

/// `json.usage ? { … } : undefined` from `xai/index.ts:459-465`.
///
/// The guard is a truthiness test, so `null`, `0`, `false` and `""` all mean "no
/// usage" while `{}` yields three zeros. Each count is read with `?? 0`; a
/// non-integer becomes `0` (divergence 8), and `total_tokens` is *not* derived from
/// the other two.
pub fn extract_xai_usage(json: &Value) -> Option<GatewayUsage> {
    let usage = json.get("usage").filter(|value| is_truthy(value))?;
    Some(GatewayUsage {
        prompt_tokens: token_count(usage.get("input_tokens")),
        completion_tokens: token_count(usage.get("output_tokens")),
        total_tokens: token_count(usage.get("total_tokens")),
    })
}

/// `value ?? 0` for a token count the API may omit.
fn token_count(value: Option<&Value>) -> i64 {
    value.and_then(Value::as_i64).unwrap_or(0)
}

/// `json.model ?? request.model` from `xai/index.ts:456`.
///
/// `??` is nullish, so only a missing or `null` model falls back; a non-string value
/// falls back too, because the response field is a `String` (divergence 6).
pub fn extract_xai_model(json: &Value, request_model: &str) -> String {
    json.get("model")
        .filter(|model| !model.is_null())
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| request_model.to_string())
}

/// `xAIProviderAdapter` from `xai/index.ts:320-478`.
#[derive(Debug, Clone, Copy, Default)]
pub struct XaiAdapter;

impl ProviderAdapter for XaiAdapter {
    fn id(&self) -> &'static str {
        "xai"
    }

    /// `fetchModels({ secret })` (`index.ts:323-342`).
    ///
    /// `GET /v1/models` with the secret in the `authorization` header — sent
    /// **verbatim**, without the `normalizeBearerSecret` pass the OpenAI-compatible
    /// layer applies. A non-2xx status is not an error: the method returns an empty
    /// list. A transport failure and an undecodable body are, because the source has
    /// no `try`/`catch` (divergence 2), as are the two malformed `data` shapes of
    /// divergence 4.
    fn fetch_models<'a>(
        &'a self,
        context: &'a ProviderExecutionContext,
        call: &'a ProviderCall<'_>,
    ) -> BoxFuture<'a, Result<Vec<FetchedModel>, HttpError>> {
        Box::pin(async move {
            // `fetchWithTimeout(url, init)` without a third argument: the shared 15 s
            // default of `HttpRequest::get`.
            let request = HttpRequest::get(models_url())
                .header("authorization", &format!("Bearer {}", context.secret));

            let response = fetch_with_timeout(call.transport, request).await?;
            if !response.is_ok() {
                return Ok(Vec::new());
            }

            let json: Value = serde_json::from_str(&response.body)
                .map_err(|error| HttpError::InvalidBody(error.to_string()))?;
            parse_models(&json, self.id())
        })
    }

    /// `testConnectivity({ secret })` (`index.ts:344-353`).
    ///
    /// The same `GET /v1/models` probe through `fetchJsonOk`, so any 2xx answer with
    /// a parsable body verifies and every other outcome — an HTTP error, an
    /// undecodable body, a transport failure — reports its message behind the
    /// `xAI connectivity failed: ` prefix. The TypeScript method destructures only
    /// `{ secret }`, so `options.model` is ignored, as is the catalog default.
    fn test_connectivity<'a>(
        &'a self,
        context: &'a ProviderExecutionContext,
        call: &'a ProviderCall<'_>,
        _model: Option<&'a str>,
    ) -> BoxFuture<'a, ConnectivityResult> {
        Box::pin(async move {
            // `fetchJsonOk(url, init)` without a third argument: the default 15 s.
            let request = HttpRequest::get(models_url())
                .header("authorization", &format!("Bearer {}", context.secret));

            match fetch_json_ok(call.transport, request, DEFAULT_REQUEST_TIMEOUT_MS).await {
                JsonOkResult::Ok(_) => ConnectivityResult::ok(CONNECTIVITY_OK),
                JsonOkResult::Err(message) => {
                    ConnectivityResult::failed(format!("{CONNECTIVITY_FAILED_PREFIX}{message}"))
                }
            }
        })
    }

    /// `dispatchGateway({ secret }, request, options)` (`index.ts:355-478`).
    ///
    /// Error policy (divergence 1): the `try { … } catch { }` of `index.ts:356-477`
    /// turns every failure into `{ ok: false, error }`, so this method always returns
    /// `Ok` and never propagates an [`HttpError`]. The empty-input short-circuit runs
    /// before the request is built, so an empty conversation never reaches the
    /// transport.
    fn dispatch_gateway<'a>(
        &'a self,
        context: &'a ProviderExecutionContext,
        call: &'a ProviderCall<'_>,
        request: &'a GatewayRequest,
        options: &'a DispatchOptions,
    ) -> BoxFuture<'a, Result<GatewayResponse, HttpError>> {
        Box::pin(async move {
            let input = build_xai_input_messages(call.attachments, &request.messages);
            let timeout_ms = dispatch_timeout_ms(has_tools(request), call.env);

            if input.is_empty() {
                return Ok(GatewayResponse::failure(
                    request.model.clone(),
                    self.id(),
                    NO_VALID_MESSAGES,
                ));
            }

            let mut http_request = HttpRequest::post(responses_url())
                .header("content-type", "application/json")
                .header("authorization", &format!("Bearer {}", context.secret))
                .timeout_ms(timeout_ms)
                .json_body(&build_gateway_body(request, input));
            // `options?.signal`. `onStreamDelta` has no counterpart, because the
            // adapter never streams (divergence 10).
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
                    Ok(json) => match resolve_output_items(&json) {
                        Ok(output) => {
                            let function_calls = extract_xai_function_calls(&output);
                            let mut result = GatewayResponse::success(
                                extract_text_from_xai_output(&output),
                                extract_xai_model(&json, &request.model),
                                self.id(),
                            );
                            result.usage = extract_xai_usage(&json);
                            result.function_calls =
                                (!function_calls.is_empty()).then_some(function_calls);
                            Ok(result)
                        }
                        // The `TypeError` the `catch` would report (divergence 7).
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

    use http::StatusCode;

    use super::*;
    use crate::model_hub::http::{HttpResponse, HttpTransport, UnreachableTransport};
    use crate::model_hub::openai_compatible::NOOP_ATTACHMENT_STORE;
    use crate::model_hub::provider_catalog::find_provider;
    use crate::model_hub::repository::encrypted_secret_input;
    use crate::model_hub::tests::StubAttachmentStore;
    use crate::model_hub::types::{
        GatewayMessageAttachment, ProviderAccountRecord, ProviderAuthMethod,
    };

    /// A key-shaped string. The adapter sends it verbatim in `authorization` — unlike
    /// the OpenAI-compatible layer it never runs `normalizeBearerSecret`.
    const SECRET: &str = "xai-not-a-real-key";

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
            provider: find_provider("xai").expect("xai is in the catalog").clone(),
            account: ProviderAccountRecord {
                id: "acc-1".to_string(),
                provider_id: "xai".to_string(),
                label: "xai".to_string(),
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

    /// Pins the two timeout variables so the assertions do not depend on the ambient
    /// environment. `dispatch_timeout_ms` itself is exercised separately, including
    /// its fallbacks.
    fn env() -> EnvOverrides {
        EnvOverrides::new()
            .with("MODEL_HUB_GATEWAY_TIMEOUT_MS", "60000")
            .with("MODEL_HUB_GATEWAY_EXEC_TIMEOUT_MS", "180000")
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

    fn user_with_attachments(
        content: &str,
        attachments: Vec<GatewayMessageAttachment>,
    ) -> GatewayMessage {
        let mut message = GatewayMessage::user(content);
        message.attachments = Some(attachments);
        message
    }

    /// The body of the first request the stub saw.
    fn sent_body(transport: &StubTransport) -> String {
        transport.seen.lock().expect("lock")[0]
            .body
            .clone()
            .expect("body")
    }

    /// `https://api.x.ai/v1` — the base URL of both endpoints (`index.ts:63`).
    #[test]
    fn urls_are_the_api_base_plus_the_endpoint() {
        assert_eq!(API_BASE_URL, "https://api.x.ai/v1");
        assert_eq!(models_url(), "https://api.x.ai/v1/models");
        assert_eq!(responses_url(), "https://api.x.ai/v1/responses");
    }

    /// `resolveModelHubGatewayTimeoutMs({ hasTools })` (`index.ts:358-360`), whose two
    /// defaults are 60 s and 180 s.
    #[test]
    fn dispatch_timeout_ms_reads_the_two_environment_variables() {
        // Values that do not parse select the documented fallbacks, which pins the
        // defaults without depending on whether the ambient environment sets them.
        let fallbacks = EnvOverrides::new()
            .with("MODEL_HUB_GATEWAY_TIMEOUT_MS", "not-a-number")
            .with("MODEL_HUB_GATEWAY_EXEC_TIMEOUT_MS", "not-a-number");
        assert_eq!(dispatch_timeout_ms(false, &fallbacks), 60_000);
        assert_eq!(dispatch_timeout_ms(true, &fallbacks), 180_000);

        let configured = EnvOverrides::new()
            .with("MODEL_HUB_GATEWAY_TIMEOUT_MS", "90000")
            .with("MODEL_HUB_GATEWAY_EXEC_TIMEOUT_MS", "120000");
        assert_eq!(dispatch_timeout_ms(false, &configured), 90_000);
        // `Math.max(baseTimeoutMs, executionTimeoutMs)` — the larger one wins.
        assert_eq!(dispatch_timeout_ms(true, &configured), 120_000);
    }

    /// `fetchModels({ secret })` (`index.ts:323-342`): a `GET` with the raw secret in
    /// `authorization`, mapped to `{ id, name, provider, owned_by, created }`.
    #[tokio::test]
    async fn fetch_models_maps_the_data_list() {
        let transport = StubTransport::new(HttpResponse::json(
            StatusCode::OK,
            &json!({
                "object": "list",
                "data": [
                    { "id": "grok-4", "object": "model", "created": 1_730_000_000, "owned_by": "xai" },
                    { "id": "grok-3" }
                ]
            }),
        ));
        let env = env();
        let models = XaiAdapter
            .fetch_models(
                &context(SECRET),
                &call(&*transport, &NOOP_ATTACHMENT_STORE, &env),
            )
            .await
            .expect("models");

        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "grok-4");
        assert_eq!(models[0].name, "grok-4", "`name` echoes the id");
        assert_eq!(models[0].provider, "xai");
        assert_eq!(models[0].owned_by.as_deref(), Some("xai"));
        assert_eq!(models[0].created, Some(1_730_000_000.0));
        assert_eq!(models[0].context_window, None, "not part of the mapping");
        assert_eq!(models[0].billing, None, "not part of the mapping");
        assert_eq!(models[1].owned_by, None);
        assert_eq!(models[1].created, None);

        let seen = transport.seen.lock().expect("lock");
        assert_eq!(seen[0].method, http::Method::GET);
        assert_eq!(seen[0].url, "https://api.x.ai/v1/models");
        assert_eq!(
            seen[0]
                .headers
                .get("authorization")
                .expect("auth")
                .to_str()
                .expect("ascii"),
            format!("Bearer {SECRET}")
        );
        assert_eq!(seen[0].timeout_ms, 15_000, "the shared default");
        assert_eq!(seen[0].body, None, "a GET carries no body");
    }

    /// `if (!response.ok) return [];` (`index.ts:329`) — an HTTP error is not a
    /// failure, it is an empty list.
    #[tokio::test]
    async fn fetch_models_returns_an_empty_list_for_a_non_2xx_status() {
        let transport = StubTransport::new(HttpResponse::json(
            StatusCode::UNAUTHORIZED,
            &json!({ "error": "invalid api key" }),
        ));
        let env = env();
        let models = XaiAdapter
            .fetch_models(
                &context(SECRET),
                &call(&*transport, &NOOP_ATTACHMENT_STORE, &env),
            )
            .await
            .expect("an HTTP error is not a rejection");

        assert!(models.is_empty());
    }

    /// A *missing or null* `data` is `?? []` (`index.ts:335`), so it is an empty list.
    #[tokio::test]
    async fn fetch_models_treats_a_nullish_data_key_as_an_empty_list() {
        let env = env();
        for body in [json!({ "object": "list" }), json!({ "data": null })] {
            let transport = StubTransport::new(HttpResponse::json(StatusCode::OK, &body));
            let models = XaiAdapter
                .fetch_models(
                    &context(SECRET),
                    &call(&*transport, &NOOP_ATTACHMENT_STORE, &env),
                )
                .await
                .expect("models");
            assert_eq!(models.len(), 0, "{body}");
        }
    }

    /// `fetchModels` has no `try`/`catch` (`index.ts:323-342`), so a transport failure
    /// rejects instead of degrading to an empty list (divergence 2).
    #[tokio::test]
    async fn fetch_models_rejects_a_transport_failure() {
        let env = env();
        let call = ProviderCall {
            transport: &UnreachableTransport,
            attachments: &NOOP_ATTACHMENT_STORE,
            env: &env,
        };
        let error = XaiAdapter
            .fetch_models(&context(SECRET), &call)
            .await
            .expect_err("no try/catch");

        assert_eq!(
            error,
            HttpError::Transport("No HTTP transport is configured.".to_string())
        );
    }

    /// The two property accesses of `index.ts:335` that throw in JavaScript
    /// (divergence 4), reported with the V8 message.
    #[tokio::test]
    async fn fetch_models_rejects_the_throwing_data_shapes() {
        let env = env();
        let cases = [
            (json!({ "data": {} }), DATA_TYPE_ERROR_MESSAGE),
            (json!({ "data": "grok" }), DATA_TYPE_ERROR_MESSAGE),
            (Value::Null, NULL_DOCUMENT_MESSAGE),
        ];
        for (body, expected) in cases {
            let transport = StubTransport::new(HttpResponse::json(StatusCode::OK, &body));
            let error = XaiAdapter
                .fetch_models(
                    &context(SECRET),
                    &call(&*transport, &NOOP_ATTACHMENT_STORE, &env),
                )
                .await
                .expect_err("the property access throws");
            assert_eq!(
                error,
                HttpError::InvalidBody(expected.to_string()),
                "{body}"
            );
        }
    }

    /// `testConnectivity({ secret })` (`index.ts:344-353`): the same models endpoint
    /// through `fetchJsonOk`, and `options.model` is ignored because the TypeScript
    /// method destructures only `{ secret }`.
    #[tokio::test]
    async fn test_connectivity_verifies_on_any_2xx_models_response() {
        let transport =
            StubTransport::new(HttpResponse::json(StatusCode::OK, &json!({ "data": [] })));
        let env = env();
        let result = XaiAdapter
            .test_connectivity(
                &context(SECRET),
                &call(&*transport, &NOOP_ATTACHMENT_STORE, &env),
                Some("grok-4"),
            )
            .await;

        assert_eq!(
            result,
            ConnectivityResult::ok("xAI connectivity verified (models list reachable).")
        );
        assert_eq!(result.rate_limits, None, "no rate-limit header is read");

        let seen = transport.seen.lock().expect("lock");
        assert_eq!(seen.len(), 1, "a single models probe, no chat request");
        assert_eq!(seen[0].method, http::Method::GET);
        assert_eq!(seen[0].url, models_url());
        assert_eq!(
            seen[0]
                .headers
                .get("authorization")
                .expect("auth")
                .to_str()
                .expect("ascii"),
            format!("Bearer {SECRET}")
        );
        assert_eq!(seen[0].timeout_ms, 15_000, "`fetchJsonOk` default");
    }

    /// A non-2xx answer reports `parseErrorMessage` behind the prefix
    /// (`index.ts:352`).
    #[tokio::test]
    async fn test_connectivity_prefixes_the_parse_error_message() {
        let transport = StubTransport::new(HttpResponse::json(
            StatusCode::UNAUTHORIZED,
            &json!({ "error": { "message": "invalid api key" } }),
        ));
        let env = env();
        let result = XaiAdapter
            .test_connectivity(
                &context(SECRET),
                &call(&*transport, &NOOP_ATTACHMENT_STORE, &env),
                None,
            )
            .await;

        assert_eq!(
            result,
            ConnectivityResult::failed("xAI connectivity failed: invalid api key")
        );
    }

    /// `fetchJsonOk` turns every thrown error into `{ ok: false, message }`
    /// (`http.ts:89-92`), so a transport failure becomes a failed result.
    #[tokio::test]
    async fn test_connectivity_reports_a_transport_failure() {
        let env = env();
        let call = ProviderCall {
            transport: &UnreachableTransport,
            attachments: &NOOP_ATTACHMENT_STORE,
            env: &env,
        };
        let result = XaiAdapter
            .test_connectivity(&context(SECRET), &call, None)
            .await;

        assert_eq!(
            result,
            ConnectivityResult::failed("xAI connectivity failed: No HTTP transport is configured.")
        );
    }

    /// The full `POST /v1/responses` request of `index.ts:373-417`.
    fn gateway_request() -> GatewayRequest {
        let mut request = GatewayRequest::new(
            "grok-4",
            vec![
                GatewayMessage::new(GatewayRole::System, "Be terse."),
                GatewayMessage::user("Hello"),
                GatewayMessage::new(GatewayRole::Assistant, "Hi"),
            ],
        );
        request.max_tokens = Some(64);
        request.temperature = Some(0.25);
        request.response_format = Some(json!({
            "type": "json_schema",
            "json_schema": { "name": "answer", "schema": { "type": "object" }, "strict": false }
        }));
        request.tools = Some(vec![json!({
            "type": "function",
            "name": "get_weather",
            "description": "Look up the weather",
            "parameters": { "type": "object" }
        })]);
        request
    }

    /// Method, URL, headers, body key order and the 180 s tool timeout.
    #[tokio::test]
    async fn dispatch_gateway_sends_the_responses_request() {
        let transport =
            StubTransport::new(HttpResponse::json(StatusCode::OK, &json!({ "output": [] })));
        let env = env();
        let response = XaiAdapter
            .dispatch_gateway(
                &context(SECRET),
                &call(&*transport, &NOOP_ATTACHMENT_STORE, &env),
                &gateway_request(),
                &DispatchOptions::default(),
            )
            .await
            .expect("dispatch");

        assert!(response.ok);

        let seen = transport.seen.lock().expect("lock");
        assert_eq!(seen[0].method, http::Method::POST);
        assert_eq!(seen[0].url, "https://api.x.ai/v1/responses");
        assert_eq!(
            seen[0].headers.get("content-type").expect("ctype"),
            "application/json"
        );
        assert_eq!(
            seen[0]
                .headers
                .get("authorization")
                .expect("auth")
                .to_str()
                .expect("ascii"),
            format!("Bearer {SECRET}")
        );
        assert_eq!(
            seen[0].timeout_ms, 180_000,
            "`hasTools` selects the exec timeout"
        );
        assert_eq!(
            seen[0].body.as_deref().expect("body"),
            r#"{"model":"grok-4","input":[{"role":"system","content":"Be terse."},{"role":"user","content":"Hello"},{"role":"assistant","content":"Hi"}],"store":false,"max_output_tokens":64,"text":{"format":{"type":"json_schema","name":"answer","schema":{"type":"object"},"strict":false}},"temperature":0.25,"tools":[{"type":"function","name":"get_weather","description":"Look up the weather","parameters":{"type":"object"}}],"tool_choice":"auto","parallel_tool_calls":true}"#
        );
    }

    /// Response parsing: `output` items, text extraction, function calls, usage and
    /// `json.model ?? request.model`.
    #[tokio::test]
    async fn dispatch_gateway_parses_text_usage_and_function_calls() {
        let transport = StubTransport::new(HttpResponse::json(
            StatusCode::OK,
            &json!({
                "id": "resp_1",
                "model": "grok-4-0709",
                "output": [
                    { "type": "reasoning", "summary": [] },
                    {
                        "type": "message",
                        "role": "assistant",
                        "content": [
                            { "type": "output_text", "text": " Hello" },
                            { "type": "refusal", "text": "nope" },
                            { "type": "output_text", "text": " world  " }
                        ]
                    },
                    {
                        "type": "function_call",
                        "name": "get_weather",
                        "arguments": "{\"city\":\"Berlin\"}",
                        "call_id": "c1"
                    },
                    { "type": "function_call", "name": "search", "arguments": "{oops" },
                    { "type": "function_call", "name": "direct", "arguments": { "a": 1 } },
                    { "type": "function_call", "name": "nothing" }
                ],
                "usage": { "input_tokens": 12, "output_tokens": 5, "total_tokens": 17 }
            }),
        ));
        let env = env();
        let response = XaiAdapter
            .dispatch_gateway(
                &context(SECRET),
                &call(&*transport, &NOOP_ATTACHMENT_STORE, &env),
                &GatewayRequest::new("grok-4", vec![GatewayMessage::user("ping")]),
                &DispatchOptions::default(),
            )
            .await
            .expect("dispatch");

        assert!(response.ok);
        assert_eq!(
            response.text, "Hello world",
            "`join('')` plus one final trim"
        );
        assert_eq!(
            response.model, "grok-4-0709",
            "`json.model ?? request.model`"
        );
        assert_eq!(response.provider, "xai");
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
        assert_eq!(calls.len(), 4);
        assert_eq!(calls[0].name, "get_weather");
        assert_eq!(calls[0].args, Some(json!({ "city": "Berlin" })));
        assert_eq!(
            calls[1].args,
            Some(json!({ "raw": "{oops" })),
            "an unparsable `arguments` string becomes `{{ raw }}`"
        );
        assert_eq!(
            calls[2].args,
            Some(json!({ "a": 1 })),
            "an object is copied"
        );
        assert_eq!(calls[3].args, None, "`{{ name }}` carries no `args` key");
    }

    /// The optional body keys and both outcome keys disappear when the request and
    /// the response carry none.
    #[tokio::test]
    async fn dispatch_gateway_omits_the_optional_keys() {
        let transport = StubTransport::new(HttpResponse::json(
            StatusCode::OK,
            &json!({
                "output": [
                    { "type": "message", "content": [{ "type": "output_text", "text": "pong" }] }
                ]
            }),
        ));
        let env = env();
        let response = XaiAdapter
            .dispatch_gateway(
                &context(SECRET),
                &call(&*transport, &NOOP_ATTACHMENT_STORE, &env),
                &GatewayRequest::new("grok-4", vec![GatewayMessage::user("ping")]),
                &DispatchOptions::default(),
            )
            .await
            .expect("dispatch");

        assert!(response.ok);
        assert_eq!(response.text, "pong");
        assert_eq!(response.model, "grok-4", "`json.model ?? request.model`");
        assert_eq!(response.usage, None);
        assert_eq!(response.function_calls, None);
        assert_eq!(response.rate_limits, None);
        assert_eq!(
            sent_body(&transport),
            r#"{"model":"grok-4","input":[{"role":"user","content":"ping"}],"store":false}"#
        );
        assert_eq!(
            transport.seen.lock().expect("lock")[0].timeout_ms,
            60_000,
            "no tools"
        );
    }

    /// `if (request.max_tokens)` is truthiness while `temperature !== undefined` is
    /// not, so `0` is skipped for one and kept for the other (`index.ts:379-390`). An
    /// empty tool list also neither adds `tools` nor the exec timeout.
    #[tokio::test]
    async fn dispatch_gateway_keeps_a_zero_temperature_and_drops_zero_max_tokens() {
        let transport =
            StubTransport::new(HttpResponse::json(StatusCode::OK, &json!({ "output": [] })));
        let env = env();
        let mut request = GatewayRequest::new("m", vec![GatewayMessage::user("hi")]);
        request.max_tokens = Some(0);
        request.temperature = Some(0.0);
        request.response_mime_type = Some("application/json".to_string());
        request.tools = Some(Vec::new());

        XaiAdapter
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
            r#"{"model":"m","input":[{"role":"user","content":"hi"}],"store":false,"text":{"format":{"type":"json_object"}},"temperature":0.0}"#
        );
        assert_eq!(transport.seen.lock().expect("lock")[0].timeout_ms, 60_000);
    }

    /// `if (input.length === 0)` short-circuits before the body is built
    /// (`index.ts:362-370`), so no request is sent.
    #[tokio::test]
    async fn dispatch_gateway_short_circuits_an_empty_conversation() {
        let transport =
            StubTransport::new(HttpResponse::json(StatusCode::OK, &json!({ "output": [] })));
        let env = env();
        let response = XaiAdapter
            .dispatch_gateway(
                &context(SECRET),
                &call(&*transport, &NOOP_ATTACHMENT_STORE, &env),
                &GatewayRequest::new("grok-4", Vec::new()),
                &DispatchOptions::default(),
            )
            .await
            .expect("dispatch");

        assert!(!response.ok);
        assert_eq!(response.error.as_deref(), Some("No valid messages to send"));
        assert_eq!(response.text, "");
        assert_eq!(response.model, "grok-4");
        assert_eq!(response.provider, "xai");
        assert!(
            transport.seen.lock().expect("lock").is_empty(),
            "the transport is never reached"
        );
    }

    /// The failure paths of `dispatchGateway`: an HTTP error, an `output` that cannot
    /// be iterated, an undecodable body and a transport failure — all as
    /// `{ ok: false, error }` (divergence 1).
    #[tokio::test]
    async fn dispatch_gateway_reports_an_http_error_with_the_inline_branch() {
        let transport = StubTransport::new(HttpResponse::json(
            StatusCode::TOO_MANY_REQUESTS,
            &json!({ "error": "rate limited" }),
        ));
        let env = env();
        let response = XaiAdapter
            .dispatch_gateway(
                &context(SECRET),
                &call(&*transport, &NOOP_ATTACHMENT_STORE, &env),
                &gateway_request(),
                &DispatchOptions::default(),
            )
            .await
            .expect("dispatch");

        assert!(!response.ok);
        assert_eq!(response.error.as_deref(), Some("rate limited"));
        assert_eq!(response.text, "");
        assert_eq!(response.model, "grok-4");
        assert_eq!(response.provider, "xai");
        assert_eq!(response.usage, None);
    }

    /// `for (const item of output)` over a non-nullish non-array throws in JavaScript
    /// (divergence 7); a string is iterable and equivalent to an empty list.
    #[tokio::test]
    async fn dispatch_gateway_reports_a_non_iterable_output_as_a_failure() {
        let env = env();
        for body in [json!({ "output": 5 }), json!({ "output": { "a": 1 } })] {
            let transport = StubTransport::new(HttpResponse::json(StatusCode::OK, &body));
            let response = XaiAdapter
                .dispatch_gateway(
                    &context(SECRET),
                    &call(&*transport, &NOOP_ATTACHMENT_STORE, &env),
                    &GatewayRequest::new("m", vec![GatewayMessage::user("hi")]),
                    &DispatchOptions::default(),
                )
                .await
                .expect("dispatch");
            assert!(!response.ok, "{body}");
            assert_eq!(
                response.error.as_deref(),
                Some(NOT_ITERABLE_MESSAGE),
                "{body}"
            );
        }

        let transport = StubTransport::new(HttpResponse::json(
            StatusCode::OK,
            &json!({ "output": "abc" }),
        ));
        let response = XaiAdapter
            .dispatch_gateway(
                &context(SECRET),
                &call(&*transport, &NOOP_ATTACHMENT_STORE, &env),
                &GatewayRequest::new("m", vec![GatewayMessage::user("hi")]),
                &DispatchOptions::default(),
            )
            .await
            .expect("dispatch");
        assert!(response.ok, "a string is iterable and yields no items");
        assert_eq!(response.text, "");
    }

    /// `await response.json()` failing is the `SyntaxError` the `catch` reports; only
    /// the text differs from V8 (divergence 5).
    #[tokio::test]
    async fn dispatch_gateway_reports_an_undecodable_body_as_a_failure() {
        let transport = StubTransport::new(HttpResponse::text(StatusCode::OK, "<html>nope</html>"));
        let env = env();
        let response = XaiAdapter
            .dispatch_gateway(
                &context(SECRET),
                &call(&*transport, &NOOP_ATTACHMENT_STORE, &env),
                &GatewayRequest::new("m", vec![GatewayMessage::user("hi")]),
                &DispatchOptions::default(),
            )
            .await
            .expect("dispatch");

        assert!(!response.ok);
        assert!(response.text.is_empty());
        let error = response.error.expect("error");
        assert!(!error.is_empty(), "the `SyntaxError` text is reported");
    }

    /// `try { … } catch { }`: a transport failure becomes a failed response, never an
    /// `Err` (divergence 1).
    #[tokio::test]
    async fn dispatch_gateway_reports_a_transport_failure_as_a_failed_response() {
        let env = env();
        let call = ProviderCall {
            transport: &UnreachableTransport,
            attachments: &NOOP_ATTACHMENT_STORE,
            env: &env,
        };
        let response = XaiAdapter
            .dispatch_gateway(
                &context(SECRET),
                &call,
                &gateway_request(),
                &DispatchOptions::default(),
            )
            .await
            .expect("xai swallows the transport error");

        assert!(!response.ok);
        assert_eq!(
            response.error.as_deref(),
            Some("No HTTP transport is configured.")
        );
        assert_eq!(response.provider, "xai");
    }

    /// `options?.signal` is forwarded when the caller supplies one.
    #[tokio::test]
    async fn dispatch_gateway_forwards_the_abort_signal() {
        let transport =
            StubTransport::new(HttpResponse::json(StatusCode::OK, &json!({ "output": [] })));
        let env = env();
        let abort = crate::model_hub::http::AbortSignal::new();
        abort.abort();

        let response = XaiAdapter
            .dispatch_gateway(
                &context(SECRET),
                &call(&*transport, &NOOP_ATTACHMENT_STORE, &env),
                &GatewayRequest::new("m", vec![GatewayMessage::user("hi")]),
                &DispatchOptions {
                    abort: Some(abort),
                    ..DispatchOptions::default()
                },
            )
            .await
            .expect("an abort is a failed response, not an Err");

        assert!(!response.ok);
        assert_eq!(
            response.error.as_deref(),
            Some("The operation was aborted"),
            "divergence 12"
        );
        assert!(
            transport.seen.lock().expect("lock").is_empty(),
            "an already aborted signal never reaches the transport"
        );
    }

    /// The text collected so far is flushed before an inlined image
    /// (`index.ts:168-179`).
    #[tokio::test]
    async fn dispatch_gateway_flushes_text_before_an_inlined_image() {
        let store = StubAttachmentStore::new(vec![("pixel.png", "image/png", b"PNGDATA".to_vec())]);
        let transport =
            StubTransport::new(HttpResponse::json(StatusCode::OK, &json!({ "output": [] })));
        let env = env();
        let request = GatewayRequest::new(
            "grok-4",
            vec![user_with_attachments(
                "  Look at this  ",
                vec![attachment("pixel.png", "image/png", 7, "pixel.png")],
            )],
        );

        XaiAdapter
            .dispatch_gateway(
                &context(SECRET),
                &call(&*transport, &store, &env),
                &request,
                &DispatchOptions::default(),
            )
            .await
            .expect("dispatch");

        assert_eq!(
            sent_body(&transport),
            r#"{"model":"grok-4","input":[{"role":"user","content":[{"type":"text","text":"Look at this"},{"type":"image_url","image_url":{"url":"data:image/png;base64,UE5HREFUQQ=="}}]}],"store":false}"#
        );
    }

    /// A text attachment is inlined as a snippet and an unreadable one degrades to the
    /// placeholder, both joined with a blank line (`index.ts:184-203`).
    #[tokio::test]
    async fn dispatch_gateway_inlines_text_snippets_and_placeholders() {
        let store =
            StubAttachmentStore::new(vec![("note.txt", "text/plain", b"  hi there  ".to_vec())]);
        let transport =
            StubTransport::new(HttpResponse::json(StatusCode::OK, &json!({ "output": [] })));
        let env = env();
        let request = GatewayRequest::new(
            "grok-4",
            vec![user_with_attachments(
                "Summary",
                vec![
                    attachment("note.txt", "text/plain", 12, "note.txt"),
                    attachment("report.pdf", "application/pdf", 9, "report.pdf"),
                ],
            )],
        );

        XaiAdapter
            .dispatch_gateway(
                &context(SECRET),
                &call(&*transport, &store, &env),
                &request,
                &DispatchOptions::default(),
            )
            .await
            .expect("dispatch");

        assert_eq!(
            sent_body(&transport),
            r#"{"model":"grok-4","input":[{"role":"user","content":[{"type":"text","text":"Summary\n\nAttachment note.txt (text/plain):\nhi there\n\n[Attachment: report.pdf (application/pdf, 9 bytes)]"}]}],"store":false}"#
        );
    }

    /// Only the **last** user message with attachments may inline binary data
    /// (`index.ts:116-123`); every earlier one degrades to the placeholder.
    #[tokio::test]
    async fn only_the_latest_user_message_inlines_binary_attachments() {
        let store = StubAttachmentStore::new(vec![
            ("old.png", "image/png", b"PNGDATA".to_vec()),
            ("new.png", "image/png", b"PNGDATA".to_vec()),
        ]);
        let transport =
            StubTransport::new(HttpResponse::json(StatusCode::OK, &json!({ "output": [] })));
        let env = env();
        let request = GatewayRequest::new(
            "grok-4",
            vec![
                user_with_attachments(
                    "first",
                    vec![attachment("old.png", "image/png", 7, "old.png")],
                ),
                GatewayMessage::new(GatewayRole::Assistant, "ok"),
                user_with_attachments(
                    "second",
                    vec![attachment("new.png", "image/png", 7, "new.png")],
                ),
            ],
        );

        XaiAdapter
            .dispatch_gateway(
                &context(SECRET),
                &call(&*transport, &store, &env),
                &request,
                &DispatchOptions::default(),
            )
            .await
            .expect("dispatch");

        assert_eq!(
            sent_body(&transport),
            r#"{"model":"grok-4","input":[{"role":"user","content":[{"type":"text","text":"first\n\n[Attachment: old.png (image/png, 7 bytes)]"}]},{"role":"assistant","content":"ok"},{"role":"user","content":[{"type":"text","text":"second"},{"type":"image_url","image_url":{"url":"data:image/png;base64,UE5HREFUQQ=="}}]}],"store":false}"#
        );
    }

    /// Every message yields exactly one input entry, and whitespace-only content
    /// contributes no leading text part (`index.ts:156-160`).
    #[test]
    fn build_xai_input_messages_keeps_every_message_and_drops_blank_content() {
        let store = NOOP_ATTACHMENT_STORE;
        let input = build_xai_input_messages(
            &store,
            &[
                GatewayMessage::new(GatewayRole::System, "be terse"),
                GatewayMessage::new(GatewayRole::Assistant, "hi"),
                user_with_attachments(
                    "   ",
                    vec![attachment("a.pdf", "application/pdf", 3, "a.pdf")],
                ),
            ],
        );

        assert_eq!(
            input,
            vec![
                json!({ "role": "system", "content": "be terse" }),
                json!({ "role": "assistant", "content": "hi" }),
                json!({
                    "role": "user",
                    "content": [{ "type": "text", "text": "[Attachment: a.pdf (application/pdf, 3 bytes)]" }]
                }),
            ]
        );
    }

    /// An empty conversation produces no input at all, which is what the
    /// short-circuit keys off.
    #[test]
    fn build_xai_input_messages_is_empty_for_no_messages() {
        assert!(build_xai_input_messages(&NOOP_ATTACHMENT_STORE, &[]).is_empty());
    }

    /// `mapResponseFormat` (`index.ts:65-87`).
    #[test]
    fn map_response_format_follows_the_typescript_precedence() {
        assert_eq!(
            map_response_format(Some(&json!({ "type": "json_object" })), None),
            Some(json!({ "type": "json_object" }))
        );
        // The Responses shape is flat, and `strict` defaults to `true`.
        assert_eq!(
            map_response_format(
                Some(&json!({
                    "type": "json_schema",
                    "json_schema": { "name": "answer", "schema": { "type": "object" } }
                })),
                None
            ),
            Some(json!({
                "type": "json_schema",
                "name": "answer",
                "schema": { "type": "object" },
                "strict": true
            }))
        );
        // `typed.json_schema.strict !== false` — only an explicit `false` turns it off.
        assert_eq!(
            map_response_format(
                Some(&json!({
                    "type": "json_schema",
                    "json_schema": { "name": "a", "schema": {}, "strict": false }
                })),
                None
            ),
            Some(json!({ "type": "json_schema", "name": "a", "schema": {}, "strict": false }))
        );
        // `String(name)` coerces a non-string name.
        assert_eq!(
            map_response_format(
                Some(&json!({ "type": "json_schema", "json_schema": { "name": 7, "schema": {} } })),
                None
            ),
            Some(json!({ "type": "json_schema", "name": "7", "schema": {}, "strict": true }))
        );
        // A falsy `name` or `schema` drops the whole `json_schema` branch, which then
        // falls through to the `responseMimeType` test.
        assert_eq!(
            map_response_format(
                Some(&json!({ "type": "json_schema", "json_schema": { "name": "a" } })),
                Some("application/json")
            ),
            Some(json!({ "type": "json_object" }))
        );
        assert_eq!(
            map_response_format(
                Some(&json!({
                    "type": "json_schema",
                    "json_schema": { "name": "", "schema": { "a": 1 } }
                })),
                None
            ),
            None
        );
        // The `responseMimeType` fallback and its negative case.
        assert_eq!(
            map_response_format(None, Some("application/json")),
            Some(json!({ "type": "json_object" }))
        );
        assert_eq!(map_response_format(None, Some("text/plain")), None);
        assert_eq!(map_response_format(None, None), None);
        // A non-object `responseFormat` is ignored.
        assert_eq!(map_response_format(Some(&json!([1])), None), None);
        assert_eq!(map_response_format(Some(&json!("json_object")), None), None);
    }

    /// `mapOpenAIToolToXAI` (`index.ts:214-257`).
    #[test]
    fn map_openai_tool_to_xai_accepts_the_direct_and_the_nested_shape() {
        assert_eq!(
            map_openai_tool_to_xai(&json!({
                "type": "function",
                "name": "get_weather",
                "description": "Look up the weather",
                "parameters": { "type": "object" },
                "strict": true
            })),
            Some(json!({
                "type": "function",
                "name": "get_weather",
                "description": "Look up the weather",
                "parameters": { "type": "object" },
                "strict": true
            }))
        );
        // The nested `function` shape, with the name trimmed and `strict: false` kept.
        assert_eq!(
            map_openai_tool_to_xai(&json!({
                "type": "function",
                "function": {
                    "name": " nested ",
                    "parameters": { "type": "object", "properties": {} },
                    "strict": false
                }
            })),
            Some(json!({
                "type": "function",
                "name": "nested",
                "parameters": { "type": "object", "properties": {} },
                "strict": false
            }))
        );
        // `??` is nullish: an empty description survives, `parameters: null` falls
        // through to the nested value.
        assert_eq!(
            map_openai_tool_to_xai(&json!({
                "type": "function",
                "name": "direct",
                "description": "",
                "parameters": null,
                "function": {
                    "name": "nested",
                    "description": "nested",
                    "parameters": { "type": "object" }
                }
            })),
            Some(json!({
                "type": "function",
                "name": "direct",
                "description": "",
                "parameters": { "type": "object" }
            }))
        );
        // Dropped shapes: no `type`, a different `type`, an empty name, a non-object
        // and an array.
        assert_eq!(map_openai_tool_to_xai(&json!({ "name": "x" })), None);
        assert_eq!(
            map_openai_tool_to_xai(&json!({ "type": "custom", "name": "x" })),
            None
        );
        assert_eq!(
            map_openai_tool_to_xai(&json!({ "type": "function", "name": "   " })),
            None
        );
        assert_eq!(map_openai_tool_to_xai(&json!("x")), None);
        assert_eq!(
            map_openai_tool_to_xai(&json!([{ "type": "function", "name": "x" }])),
            None
        );
    }

    /// `extractXAIFunctionCalls` (`index.ts:259-290`) for every `arguments` shape.
    #[test]
    fn extract_xai_function_calls_handles_every_arguments_shape() {
        let output = vec![
            json!({ "type": "message", "content": [] }),
            json!({ "type": "function_call", "name": "parsed", "arguments": "{\"a\":1}" }),
            json!({ "type": "function_call", "name": "raw", "arguments": "{oops" }),
            json!({ "type": "function_call", "name": "object", "arguments": { "a": 1 } }),
            json!({ "type": "function_call", "name": "array", "arguments": [1, 2] }),
            json!({ "type": "function_call", "name": "scalar", "arguments": 5 }),
            json!({ "type": "function_call", "name": "missing" }),
            json!({ "type": "function_call" }),
            json!("not an object"),
            json!([{ "type": "function_call", "name": "in an array" }]),
        ];

        let calls = extract_xai_function_calls(&output);

        assert_eq!(calls.len(), 6);
        assert_eq!(calls[0].name, "parsed");
        assert_eq!(calls[0].args, Some(json!({ "a": 1 })));
        assert_eq!(calls[1].name, "raw");
        assert_eq!(calls[1].args, Some(json!({ "raw": "{oops" })));
        assert_eq!(calls[2].args, Some(json!({ "a": 1 })));
        assert_eq!(
            calls[3].args,
            Some(json!([1, 2])),
            "an array is `typeof 'object'` too"
        );
        assert_eq!(calls[4].args, None, "a non-object leaves `args` unset");
        assert_eq!(calls[5].args, None);
    }

    /// `extractTextFromXAIOutput` (`index.ts:292-318`) joins with no separator and
    /// trims once.
    #[test]
    fn extract_text_from_xai_output_joins_output_text_and_trims_once() {
        let output = vec![
            json!({ "type": "function_call", "name": "x" }),
            json!({
                "type": "message",
                "content": [
                    { "type": "output_text", "text": " Hello" },
                    { "type": "output_text" },
                    { "type": "output_text", "text": 5 },
                    { "type": "refusal", "text": "nope" },
                    "raw"
                ]
            }),
            json!({ "type": "message", "content": "not an array" }),
            json!({
                "type": "message",
                "content": [{ "type": "output_text", "text": " world  " }]
            }),
        ];

        assert_eq!(extract_text_from_xai_output(&output), "Hello world");
        assert_eq!(extract_text_from_xai_output(&[]), "");
    }

    /// `json.usage ? { … } : undefined` (`index.ts:459-465`).
    #[test]
    fn extract_xai_usage_uses_truthiness_and_does_not_sum() {
        assert_eq!(
            extract_xai_usage(&json!({
                "usage": { "input_tokens": 3, "output_tokens": 1, "total_tokens": 7 }
            })),
            Some(GatewayUsage {
                prompt_tokens: 3,
                completion_tokens: 1,
                total_tokens: 7,
            }),
            "`total_tokens` comes from the response, not from a sum"
        );
        assert_eq!(
            extract_xai_usage(&json!({ "usage": {} })),
            Some(GatewayUsage::default()),
            "`{{}}` is truthy, so three zeros"
        );
        assert_eq!(extract_xai_usage(&json!({ "usage": null })), None);
        assert_eq!(extract_xai_usage(&json!({ "usage": 0 })), None);
        assert_eq!(extract_xai_usage(&json!({ "usage": false })), None);
        assert_eq!(extract_xai_usage(&json!({ "usage": "" })), None);
        assert_eq!(extract_xai_usage(&json!({})), None);
        // A fractional or non-numeric count has no `i64` reading and becomes `0`.
        assert_eq!(
            extract_xai_usage(&json!({
                "usage": { "input_tokens": 1.5, "output_tokens": -2, "total_tokens": "9" }
            })),
            Some(GatewayUsage {
                prompt_tokens: 0,
                completion_tokens: -2,
                total_tokens: 0,
            })
        );
    }

    /// `json.model ?? request.model` (`index.ts:456`), including divergence 6.
    #[test]
    fn extract_xai_model_falls_back_on_a_nullish_or_non_string_model() {
        assert_eq!(
            extract_xai_model(&json!({ "model": "grok-4-0709" }), "request"),
            "grok-4-0709"
        );
        assert_eq!(extract_xai_model(&json!({}), "request"), "request");
        assert_eq!(
            extract_xai_model(&json!({ "model": null }), "request"),
            "request"
        );
        assert_eq!(
            extract_xai_model(&json!({ "model": 5 }), "request"),
            "request",
            "a non-string model cannot be copied into a `String` field"
        );
    }

    /// The inline error branch (`index.ts:419-442`), which is *not* the shared
    /// `parseErrorMessage`.
    #[test]
    fn error_message_for_failed_response_matches_the_inline_branch() {
        let failed = |body: &str| {
            error_message_for_failed_response(&HttpResponse::text(StatusCode::BAD_REQUEST, body))
        };

        assert_eq!(failed(r#"{"error":"boom"}"#), "boom");
        assert_eq!(failed(r#"{"error":{"message":"nested"}}"#), "nested");
        // A top-level `message` is not consulted, unlike `http.ts:50-69`.
        assert_eq!(failed(r#"{"message":"top"}"#), r#"{"message":"top"}"#);
        // `typeof … === 'string'` accepts an empty string, and it beats
        // `error.message` because the string branch comes first.
        assert_eq!(failed(r#"{"error":""}"#), "");
        assert_eq!(failed(r#"{"error":{"message":""}}"#), "");
        assert_eq!(
            failed(r#"{"error":{"message":5}}"#),
            r#"{"error":{"message":5}}"#
        );
        // An unparsable body is used verbatim and untrimmed; a body that parsed to
        // `null` throws on the property access and lands here too.
        assert_eq!(failed("  upstream died  "), "  upstream died  ");
        assert_eq!(failed("<html>nope</html>"), "<html>nope</html>");
        assert_eq!(failed("null"), "null");
        assert_eq!(failed("[]"), "[]");
        // Only an empty body falls back to the status line — without a reason phrase.
        assert_eq!(failed(""), "HTTP 400");
    }
}
