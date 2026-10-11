//! Port of `src/server/model-hub/Models/cohere/index.ts`.
//!
//! # The v2 wire format is not OpenAI's
//!
//! `cohere/index.ts` imports no SDK: both requests are built by hand and sent
//! through the shared `fetchWithTimeout` / `fetchJsonOk` helpers, so nothing has to
//! be translated. What *does* differ from every OpenAI-compatible provider is the
//! shape on the wire — Cohere's v2 API answers with `message.content[]` blocks and
//! `usage.tokens`, where OpenAI answers with `choices[]` and `usage.prompt_tokens`:
//!
//! | TypeScript | REST |
//! | --- | --- |
//! | `fetchWithTimeout('https://api.cohere.com/v2/models', { method: 'GET', headers: { Authorization: `Bearer ${secret}` } })` (`index.ts:8-11`) | `GET https://api.cohere.com/v2/models` with `Authorization: Bearer <secret>`, shared 15 s default timeout |
//! | `fetchJsonOk('https://api.cohere.com/v2/models', …)` (`index.ts:24-27`) | the same endpoint — the payload is discarded, only `ok`/`message` are used |
//! | `fetchWithTimeout('https://api.cohere.com/v2/chat', { …, body: JSON.stringify(body) }, 60_000)` (`index.ts:64-75`) | `POST https://api.cohere.com/v2/chat` with `Authorization` and `Content-Type: application/json`, **hard-coded 60 s** (`index.ts:74`) |
//! | `body = { model, messages: [{ role, content }], stream: false }` + optional `max_tokens` / `temperature` (`index.ts:51-62`) | the request body; `messages` carries a `system` entry only when the joined system text is non-empty, and `stream` is always `false` |
//! | `json.message.content.filter(b => b.type === 'text').map(b => b.text ?? '').join('')` (`index.ts:104-108`) | the answer text: `message.content[]` blocks, `type: 'text'` only |
//! | `json.usage.tokens ?? json.usage.billed_units` → `{ input_tokens, output_tokens }` (`index.ts:110-121`) | the usage block; `billed_units` is the legacy fallback spelling |
//!
//! `'https://api.cohere.com/v2'` (`index.ts:8`) is the `apiBaseUrl` of the
//! `cohere-native` catalog entry (`providerCatalog.ts:122`, mirrored at
//! `provider_catalog.rs:212-221`). The port keeps that literal instead of reading
//! `context.provider.api_base_url`, exactly like the Anthropic, xAI and Mistral
//! adapters; `context.provider` and `context.account` are never read at all.
//!
//! # Model discovery
//!
//! `fetchModels` reads `GET /v2/models`, which answers
//! `{ models: [{ name, endpoints: [...] }] }`. Only entries whose `endpoints`
//! contains the string `chat` survive (`index.ts:19`), and a surviving `name`
//! becomes both `id` and `name` (`index.ts:20`). No static model list is embedded —
//! unlike Anthropic — and `defaultModels` (`command-a-03-2025`, `command-r-plus`)
//! is *not* consulted. A non-2xx status is not an error: it yields an empty list
//! (`index.ts:12`).
//!
//! | Rust item | TypeScript |
//! | --- | --- |
//! | [`API_BASE_URL`], [`models_url`], [`chat_url`], [`DISPATCH_TIMEOUT_MS`] | `index.ts:8`, `index.ts:8`, `index.ts:65`, `index.ts:74` |
//! | [`advertises_chat`], [`resolve_model_list`], [`parse_models`] | `fetchModels`, `index.ts:7-21` |
//! | [`CONNECTIVITY_OK`], [`CONNECTIVITY_FAILED_PREFIX`] | `testConnectivity`, `index.ts:23-32` |
//! | [`build_system_message`], [`build_chat_history`], [`last_user_message`], [`build_gateway_body`] | `dispatchGateway`, `index.ts:34-62` |
//! | [`error_message_for_failed_response`] | the inline error branch, `index.ts:77-94` |
//! | [`extract_text`], [`resolve_usage_block`], [`extract_usage`] | `index.ts:96-122` |
//! | [`CohereAdapter`] | `cohereProviderAdapter`, `index.ts:4-125` |
//!
//! Note that `index.ts:40-46` keeps the last non-system message in `chatHistory`
//! *and* appends `lastUserMessage` again (`index.ts:56`): when a conversation ends
//! with a user turn, that turn is sent twice. That is the TypeScript behaviour, so
//! [`build_gateway_body`] reproduces it rather than "fixing" it.
//!
//! # Deliberate divergences
//!
//! 1. **`dispatchGateway` swallows nothing.** `index.ts:34-124` has no `try`/`catch`
//!    at all — unlike Anthropic (`anthropic/index.ts:256-380`) and xAI
//!    (`xai/index.ts:356-477`), whose `catch` turns every failure into
//!    `{ ok: false, error }`. Here a transport failure, an undecodable success body
//!    and the `TypeError`s of divergence 5 all reject and become `Err(HttpError)`;
//!    only a non-2xx status becomes `{ ok: false, error }`. `fetchModels` and
//!    `testConnectivity` have no `catch` either.
//! 2. **`options` is accepted but never read.** `CohereAdapter::dispatch_gateway`
//!    has no use for [`DispatchOptions`]: the TypeScript method is declared
//!    `dispatchGateway({ secret }, request)` (`index.ts:34`) and passes *three*
//!    arguments to `fetchWithTimeout` (`index.ts:64-75`), so there is no
//!    `options?.signal` to forward — the xAI adapter forwards one, this one does
//!    not. `options.abort` is therefore deliberately **not** attached to the
//!    request, and `onStreamDelta` has no counterpart because `stream` is hard-coded
//!    to `false` (`index.ts:58`).
//! 3. **The error branch is its own precedence, not `parseErrorMessage`.** The
//!    source (`index.ts:77-94`) runs `JSON.parse(errorText)` in its own `try` and
//!    then uses `errorJson.message ?? errorText`; when parsing throws it uses
//!    `errorText || \`HTTP ${status}\``. Two consequences the port keeps: the raw
//!    body is used verbatim and **untrimmed**, and an *empty-string* `message` is a
//!    value under `??`, so `{"message": ""}` reports `""` instead of falling back.
//!    The single narrow divergence is a `message` that is neither a string nor
//!    nullish (`{"message": 42}`): TypeScript would put the number into a `string`
//!    field, while `GatewayResponse.error` is a `String`, so the port uses the same
//!    `errorText || HTTP <status>` fallback the `catch` would have produced.
//! 4. **`usage.input_tokens ?? 0` can yield a non-integer**, which `GatewayUsage`'s
//!    `i64` fields cannot hold; a non-integer count therefore becomes `0`, the same
//!    convention as the xAI adapter.
//! 5. **Four `TypeError`s are reproduced as [`HttpError::InvalidBody`].** `index.ts`
//!    has no `catch`, so a body that parsed to `null` (`json.message`,
//!    `json.models`), a `content`/`models` value that is neither nullish nor an
//!    array (`....filter is not a function`), an `endpoints` value without an
//!    `includes` method, and a `null` element inside `content` (`block.type`) reject
//!    in TypeScript. The messages are V8's, verified with `node`, and are pinned as
//!    constants so the port fails with the same text.
//! 6. **A non-string `block.text` is skipped.** `join('')` would stringify it
//!    (`{'text': 5}` → `"5"`, `{'text': {}}` → `"[object Object]"`); `content.text`
//!    is typed `string` in the source, and inventing text is worse than dropping
//!    it, so the port keeps strings only and documents the gap here.
//! 7. **A model entry without a `string` `name` is dropped.** TypeScript's `map`
//!    would emit `id: undefined` into a field the `FetchedModel` contract declares
//!    as `id: string`, so there is no faithful target for it — the same handling as
//!    the xAI adapter.
use serde_json::{Map, Value};

use crate::model_hub::http::{
    fetch_json_ok, fetch_with_timeout, BoxFuture, HttpError, HttpRequest, HttpResponse,
    JsonOkResult, DEFAULT_REQUEST_TIMEOUT_MS,
};
use crate::model_hub::openai_compatible::DispatchOptions;
use crate::model_hub::types::{
    ConnectivityResult, FetchedModel, GatewayRequest, GatewayResponse, GatewayRole, GatewayUsage,
    ProviderExecutionContext,
};

use super::{ProviderAdapter, ProviderCall};

/// `https://api.cohere.com/v2` — the `apiBaseUrl` of the `cohere-native` entry
/// (`providerCatalog.ts:121`), spelled out at `index.ts:8` and `index.ts:65`.
pub const API_BASE_URL: &str = "https://api.cohere.com/v2";

/// The `60_000` of `index.ts:74`. Unlike the OpenAI-compatible layer this is *not*
/// `resolveModelHubGatewayTimeoutMs`, so `request.tools` and
/// `MODEL_HUB_GATEWAY_TIMEOUT_MS` have no influence on it.
pub const DISPATCH_TIMEOUT_MS: u64 = 60_000;

/// `Cohere connectivity verified (models list reachable).` — `index.ts:30`.
pub const CONNECTIVITY_OK: &str = "Cohere connectivity verified (models list reachable).";
/// `` `Cohere connectivity failed: ${result.message}` `` — `index.ts:31`.
pub const CONNECTIVITY_FAILED_PREFIX: &str = "Cohere connectivity failed: ";

/// `TypeError: Cannot read properties of null (reading 'models')` — `json.models`
/// on a body that parsed to `null` (`index.ts:18`, divergence 5).
pub const NULL_MODELS_DOCUMENT_MESSAGE: &str = "Cannot read properties of null (reading 'models')";
/// `TypeError: (json.models ?? []).filter is not a function` — a `models` that is
/// neither nullish nor an array (`index.ts:18`, divergence 5). V8 prints the source
/// text of the callee, so the `??` fallback stays in the message. Verified with
/// `node`.
pub const MODELS_TYPE_ERROR_MESSAGE: &str = "(json.models ?? []).filter is not a function";
/// `TypeError: model.endpoints?.includes is not a function` — an `endpoints` that is
/// neither nullish, nor an array, nor a string (`index.ts:19`, divergence 5).
pub const ENDPOINTS_TYPE_ERROR_MESSAGE: &str = "model.endpoints?.includes is not a function";
/// `TypeError: Cannot read properties of null (reading 'message')` — `json.message`
/// on a body that parsed to `null` (`index.ts:105`, divergence 5).
pub const NULL_MESSAGE_DOCUMENT_MESSAGE: &str =
    "Cannot read properties of null (reading 'message')";
/// `TypeError: json.message?.content?.filter is not a function` — a `content` that
/// is neither nullish nor an array (`index.ts:106`, divergence 5).
pub const CONTENT_TYPE_ERROR_MESSAGE: &str = "json.message?.content?.filter is not a function";
/// `TypeError: Cannot read properties of null (reading 'type')` — a `null` element
/// inside `content` (`index.ts:106`, divergence 5).
pub const BLOCK_TYPE_ERROR_MESSAGE: &str = "Cannot read properties of null (reading 'type')";

/// `` `${API_BASE_URL}/models` `` — `index.ts:8` and `index.ts:24`.
pub fn models_url() -> String {
    format!("{API_BASE_URL}/models")
}

/// `` `${API_BASE_URL}/chat` `` — `index.ts:65`.
pub fn chat_url() -> String {
    format!("{API_BASE_URL}/chat")
}

/// `Authorization: Bearer <secret>` — the only header of both GETs
/// (`index.ts:10` and `index.ts:26`).
fn authorization_header(secret: &str) -> String {
    format!("Bearer {secret}")
}

/// JavaScript truthiness, for `if (systemMessage)` (`index.ts:54`) and
/// `usage ? …` (`index.ts:116`). `0`, `NaN`, `''`, `null` and `false` are falsy.
fn is_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_f64().is_some_and(|value| value != 0.0),
        Value::String(value) => !value.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}
/// `model.endpoints?.includes('chat')` (`index.ts:19`).
///
/// Two JavaScript details are kept rather than normalised: the call is guarded by
/// `?.` on the *property*, so a non-nullish `endpoints` without an `includes`
/// method throws; and `includes` means *substring* matching on a string but *strict
/// equality* on an array element, so `endpoints: 'chatty'` matches while
/// `endpoints: [1]` does not.
fn advertises_chat(model: &Value) -> Result<bool, String> {
    match model.get("endpoints") {
        None | Some(Value::Null) => Ok(false),
        Some(Value::Array(endpoints)) => {
            Ok(endpoints.iter().any(|entry| entry.as_str() == Some("chat")))
        }
        Some(Value::String(endpoints)) => Ok(endpoints.contains("chat")),
        Some(_) => Err(ENDPOINTS_TYPE_ERROR_MESSAGE.to_string()),
    }
}

/// `(json.models ?? [])` (`index.ts:18`), i.e. the array the `filter` runs on.
///
/// Returns the `TypeError` text of divergence 5 as the `Err` variant.
pub fn resolve_model_list(json: &Value) -> Result<Vec<Value>, String> {
    if json.is_null() {
        return Err(NULL_MODELS_DOCUMENT_MESSAGE.to_string());
    }
    match json.get("models") {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Array(models)) => Ok(models.clone()),
        Some(_) => Err(MODELS_TYPE_ERROR_MESSAGE.to_string()),
    }
}

/// The `filter`/`map` pair of `index.ts:18-20`.
pub fn parse_models(json: &Value, provider_id: &str) -> Result<Vec<FetchedModel>, HttpError> {
    let mut models = Vec::new();
    for model in resolve_model_list(json).map_err(HttpError::InvalidBody)? {
        if !advertises_chat(&model).map_err(HttpError::InvalidBody)? {
            continue;
        }
        // Divergence 7: `model.name` of `index.ts:20` is typed `string` in the
        // `FetchedModel` contract, so an entry without one has no faithful target.
        let Some(name) = model.get("name").and_then(Value::as_str) else {
            continue;
        };
        models.push(FetchedModel {
            id: name.to_string(),
            name: name.to_string(),
            provider: provider_id.to_string(),
            owned_by: None,
            context_window: None,
            created: None,
            billing: None,
        });
    }
    Ok(models)
}
/// One `{ role, content }` entry of the v2 `messages` array (`index.ts:43-46`).
fn cohere_message(role: &str, content: &str) -> Value {
    let mut message = Map::new();
    message.insert("role".to_string(), Value::from(role));
    message.insert("content".to_string(), Value::from(content));
    Value::Object(message)
}

/// The `filter(role === 'system').map(content).join('\n')` of `index.ts:35-38`.
pub fn build_system_message(request: &GatewayRequest) -> String {
    let parts: Vec<&str> = request
        .messages
        .iter()
        .filter(|message| message.role == GatewayRole::System)
        .map(|message| message.content.as_str())
        .collect();
    parts.join("\n")
}

/// The `chatHistory` of `index.ts:40-46`: every non-system message, minus the last
/// one, with `assistant` preserved and everything else collapsed to `user`.
pub fn build_chat_history(request: &GatewayRequest) -> Vec<Value> {
    let mut history: Vec<Value> = request
        .messages
        .iter()
        .filter(|message| message.role != GatewayRole::System)
        .map(|message| {
            let role = if message.role == GatewayRole::Assistant {
                "assistant"
            } else {
                "user"
            };
            cohere_message(role, &message.content)
        })
        .collect();
    // `.slice(0, -1)` — a no-op on an empty array, as `pop` is.
    history.pop();
    history
}

/// `request.messages.filter(role === 'user').pop()?.content ?? ''`
/// (`index.ts:48-49`).
pub fn last_user_message(request: &GatewayRequest) -> String {
    request
        .messages
        .iter()
        .rfind(|message| message.role == GatewayRole::User)
        .map(|message| message.content.clone())
        .unwrap_or_default()
}

/// The `body` of `index.ts:51-62`, in the source's key order.
pub fn build_gateway_body(request: &GatewayRequest) -> Value {
    let system_message = build_system_message(request);

    let mut messages: Vec<Value> = Vec::new();
    if !system_message.is_empty() {
        messages.push(cohere_message("system", &system_message));
    }
    messages.extend(build_chat_history(request));
    messages.push(cohere_message("user", &last_user_message(request)));

    let mut body = Map::new();
    body.insert("model".to_string(), Value::from(request.model.clone()));
    body.insert("messages".to_string(), Value::Array(messages));
    body.insert("stream".to_string(), Value::from(false));

    // `if (request.max_tokens)` — a truthiness test, so `0` is omitted.
    if let Some(max_tokens) = request.max_tokens.filter(|max_tokens| *max_tokens != 0) {
        body.insert("max_tokens".to_string(), Value::from(max_tokens));
    }
    // `if (request.temperature !== undefined)` — an explicit nullish test, so `0`
    // *is* sent. `max_tokens` and `temperature` are the only optional fields the
    // body ever carries: `tools`, `responseFormat`, `stream` and `systemInstruction`
    // from the request are ignored by the source.
    if let Some(temperature) = request.temperature {
        body.insert("temperature".to_string(), Value::from(temperature));
    }

    Value::Object(body)
}

/// The error branch of `index.ts:77-94` (divergence 3).
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
    // `errorJson.message` on `null` throws, and the `catch` produces the very text
    // the fallback does (`errorText || \`HTTP ${status}\``).
    if json.is_null() {
        return fallback();
    }
    match json.get("message") {
        // `??` is a nullish test, so an empty message is kept verbatim.
        Some(Value::String(message)) => message.clone(),
        // Divergence 3: a non-string `message` has no `String` target.
        Some(Value::Null) | None | Some(_) => fallback(),
    }
}
/// `json.message?.content?.filter(b => b.type === 'text').map(b => b.text ?? '').join('') ?? ''`
/// (`index.ts:104-108`).
///
/// Returns the V8 `TypeError` text of divergence 5 as the `Err` variant when the
/// source would throw instead of producing text.
pub fn extract_text(json: &Value) -> Result<String, String> {
    if json.is_null() {
        return Err(NULL_MESSAGE_DOCUMENT_MESSAGE.to_string());
    }

    let content = json
        .get("message")
        .and_then(|message| message.get("content"));

    let blocks = match content {
        // `?.` on both steps, so a missing or `null` `message`/`content` is the
        // `?? ''` fallback.
        None | Some(Value::Null) => return Ok(String::new()),
        Some(Value::Array(blocks)) => blocks,
        Some(_) => return Err(CONTENT_TYPE_ERROR_MESSAGE.to_string()),
    };

    let mut text = String::new();
    for block in blocks {
        if block.is_null() {
            return Err(BLOCK_TYPE_ERROR_MESSAGE.to_string());
        }
        if block.get("type").and_then(Value::as_str) != Some("text") {
            continue;
        }
        match block.get("text") {
            None | Some(Value::Null) => {}
            Some(Value::String(fragment)) => text.push_str(fragment),
            // Divergence 6: `join('')` would stringify it.
            Some(_) => {}
        }
    }
    Ok(text)
}

/// `json.usage?.tokens ?? json.usage?.billed_units` (`index.ts:110`) after the
/// truthiness test of `index.ts:116`.
pub fn resolve_usage_block(json: &Value) -> Option<&Value> {
    let usage = json.get("usage");
    usage
        .and_then(|usage| usage.get("tokens"))
        .filter(|tokens| !tokens.is_null())
        .or_else(|| {
            usage
                .and_then(|usage| usage.get("billed_units"))
                .filter(|billed| !billed.is_null())
        })
        .filter(|block| is_truthy(block))
}

/// `` usage.input_tokens ?? 0 `` (`index.ts:118-120`, divergence 4).
fn token_count(value: Option<&Value>) -> i64 {
    value.and_then(Value::as_i64).unwrap_or(0)
}

/// The `usage ? { prompt_tokens, completion_tokens, total_tokens } : undefined` of
/// `index.ts:116-122`.
pub fn extract_usage(json: &Value) -> Option<GatewayUsage> {
    let block = resolve_usage_block(json)?;
    Some(GatewayUsage {
        prompt_tokens: token_count(block.get("input_tokens")),
        completion_tokens: token_count(block.get("output_tokens")),
        total_tokens: token_count(block.get("input_tokens"))
            + token_count(block.get("output_tokens")),
    })
}
/// `cohereProviderAdapter` from `cohere/index.ts:4-125`.
#[derive(Debug, Clone, Copy, Default)]
pub struct CohereAdapter;

impl ProviderAdapter for CohereAdapter {
    fn id(&self) -> &'static str {
        "cohere"
    }

    /// `fetchModels({ secret })` — `index.ts:7-21`. No `try`/`catch`, so a transport
    /// failure or an undecodable body is an `Err`; a non-2xx status is an empty list.
    fn fetch_models<'a>(
        &'a self,
        context: &'a ProviderExecutionContext,
        call: &'a ProviderCall<'_>,
    ) -> BoxFuture<'a, Result<Vec<FetchedModel>, HttpError>> {
        Box::pin(async move {
            let request = HttpRequest::get(models_url())
                .header("authorization", &authorization_header(&context.secret));

            let response = fetch_with_timeout(call.transport, request).await?;
            if !response.is_ok() {
                return Ok(Vec::new());
            }

            let json: Value = serde_json::from_str(&response.body)
                .map_err(|error| HttpError::InvalidBody(error.to_string()))?;
            parse_models(&json, self.id())
        })
    }

    /// `testConnectivity({ secret })` — `index.ts:23-32`. `options.model` is not part
    /// of the TypeScript signature and stays unread.
    fn test_connectivity<'a>(
        &'a self,
        context: &'a ProviderExecutionContext,
        call: &'a ProviderCall<'_>,
        _model: Option<&'a str>,
    ) -> BoxFuture<'a, ConnectivityResult> {
        Box::pin(async move {
            let request = HttpRequest::get(models_url())
                .header("authorization", &authorization_header(&context.secret));

            match fetch_json_ok(call.transport, request, DEFAULT_REQUEST_TIMEOUT_MS).await {
                JsonOkResult::Ok(_) => ConnectivityResult::ok(CONNECTIVITY_OK),
                JsonOkResult::Err(message) => {
                    ConnectivityResult::failed(format!("{CONNECTIVITY_FAILED_PREFIX}{message}"))
                }
            }
        })
    }

    /// `dispatchGateway({ secret }, request)` — `index.ts:34-124`. See divergence 1
    /// for why failures are not folded into `{ ok: false }`, and divergence 2 for why
    /// `options` stays unread.
    fn dispatch_gateway<'a>(
        &'a self,
        context: &'a ProviderExecutionContext,
        call: &'a ProviderCall<'_>,
        request: &'a GatewayRequest,
        _options: &'a DispatchOptions,
    ) -> BoxFuture<'a, Result<GatewayResponse, HttpError>> {
        Box::pin(async move {
            let http_request = HttpRequest::post(chat_url())
                .header("authorization", &authorization_header(&context.secret))
                .header("content-type", "application/json")
                .timeout_ms(DISPATCH_TIMEOUT_MS)
                .json_body(&build_gateway_body(request));

            let response = fetch_with_timeout(call.transport, http_request).await?;

            if !response.is_ok() {
                return Ok(GatewayResponse::failure(
                    request.model.clone(),
                    self.id(),
                    error_message_for_failed_response(&response),
                ));
            }

            let json: Value = serde_json::from_str(&response.body)
                .map_err(|error| HttpError::InvalidBody(error.to_string()))?;
            let text = extract_text(&json).map_err(HttpError::InvalidBody)?;

            // The answer's own `model` field is ignored: `index.ts:114` echoes
            // `request.model`.
            let mut result = GatewayResponse::success(text, request.model.clone(), self.id());
            result.usage = extract_usage(&json);
            Ok(result)
        })
    }
}
#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use http::{HeaderMap, StatusCode};

    use super::*;
    use crate::model_hub::env::EnvOverrides;
    use crate::model_hub::http::{AbortSignal, HttpTransport, UnreachableTransport};
    use crate::model_hub::openai_compatible::NOOP_ATTACHMENT_STORE;
    use crate::model_hub::provider_catalog::find_provider;
    use crate::model_hub::repository::encrypted_secret_input;
    use crate::model_hub::types::{GatewayMessage, ProviderAccountRecord, ProviderAuthMethod};

    const SECRET: &str = "cohere-secret";

    /// A transport that records every request and answers from a script.
    ///
    /// The whole [`HttpRequest`] is kept, not just the body: the hard-coded 60 s
    /// timeout of `index.ts:74` and the two headers of `index.ts:68-71` are part of
    /// the behaviour under test.
    #[derive(Default)]
    struct StubTransport {
        script: Mutex<Vec<HttpResponse>>,
        seen: Mutex<Vec<HttpRequest>>,
    }

    impl StubTransport {
        fn json(status: StatusCode, body: &Value) -> Self {
            Self {
                script: Mutex::new(vec![HttpResponse::json(status, body)]),
                seen: Mutex::new(Vec::new()),
            }
        }

        fn text(status: StatusCode, body: &str) -> Self {
            Self {
                script: Mutex::new(vec![HttpResponse::new(status, HeaderMap::new(), body)]),
                seen: Mutex::new(Vec::new()),
            }
        }

        fn sent(&self) -> Vec<HttpRequest> {
            self.seen.lock().expect("lock").clone()
        }

        fn sent_body(&self) -> Value {
            let body = self.sent()[0].body.clone().expect("body");
            serde_json::from_str(&body).expect("the sent body is JSON")
        }
    }

    impl HttpTransport for StubTransport {
        fn send<'a>(
            &'a self,
            request: HttpRequest,
        ) -> BoxFuture<'a, Result<HttpResponse, HttpError>> {
            self.seen.lock().expect("lock").push(request);
            Box::pin(async move {
                let mut script = self.script.lock().expect("lock");
                if script.is_empty() {
                    return Err(HttpError::Transport(
                        "StubTransport has no scripted response left".to_string(),
                    ));
                }
                Ok(script.remove(0))
            })
        }
    }

    fn call<'a>(transport: &'a dyn HttpTransport, env: &'a EnvOverrides) -> ProviderCall<'a> {
        ProviderCall {
            transport,
            attachments: &NOOP_ATTACHMENT_STORE,
            env,
        }
    }

    fn context(secret: &str) -> ProviderExecutionContext {
        ProviderExecutionContext {
            provider: find_provider("cohere")
                .expect("cohere is in the catalog")
                .clone(),
            account: ProviderAccountRecord {
                id: "acc-cohere".to_string(),
                provider_id: "cohere".to_string(),
                label: "Cohere".to_string(),
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

    fn request(model: &str, messages: Vec<GatewayMessage>) -> GatewayRequest {
        GatewayRequest::new(model, messages)
    }

    fn assistant(content: &str) -> GatewayMessage {
        GatewayMessage::new(GatewayRole::Assistant, content)
    }

    fn system(content: &str) -> GatewayMessage {
        GatewayMessage::new(GatewayRole::System, content)
    }

    /// `index.ts:8` and `index.ts:65`: one base, two endpoints, both under `/v2`.
    #[test]
    fn the_endpoints_are_the_v2_api_base_plus_a_suffix() {
        assert_eq!(API_BASE_URL, "https://api.cohere.com/v2");
        assert_eq!(models_url(), "https://api.cohere.com/v2/models");
        assert_eq!(chat_url(), "https://api.cohere.com/v2/chat");
        assert_eq!(DISPATCH_TIMEOUT_MS, 60_000);
    }

    /// `index.ts:8-11`: `GET /v2/models` with the bearer token and the shared 15 s
    /// default, not the dispatch timeout.
    #[tokio::test]
    async fn fetch_models_sends_a_bearer_get_to_the_models_endpoint() {
        let transport = StubTransport::json(StatusCode::OK, &serde_json::json!({ "models": [] }));
        let env = EnvOverrides::new();

        CohereAdapter
            .fetch_models(&context(SECRET), &call(&transport, &env))
            .await
            .expect("models");

        let sent = transport.sent();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].method.as_str(), "GET");
        assert_eq!(sent[0].url, "https://api.cohere.com/v2/models");
        assert_eq!(sent[0].headers["authorization"], "Bearer cohere-secret");
        assert_eq!(sent[0].body, None);
        assert_eq!(sent[0].timeout_ms, DEFAULT_REQUEST_TIMEOUT_MS);
        assert!(sent[0].abort.is_none());
    }

    /// `index.ts:18-20`: only `endpoints` entries containing `chat` survive, and the
    /// surviving `name` is both `id` and `name` — with no `ownedBy`/`contextWindow`.
    #[tokio::test]
    async fn fetch_models_keeps_only_the_chat_models() {
        let transport = StubTransport::json(
            StatusCode::OK,
            &serde_json::json!({
                "models": [
                    { "name": "command-a-03-2025", "endpoints": ["chat", "embed"] },
                    { "name": "embed-english-v3.0", "endpoints": ["embed"] },
                    { "name": "no-endpoints" },
                    { "name": "chat-r-plus", "endpoints": "chatty" },
                    { "name": "number-endpoints", "endpoints": [1] }
                ]
            }),
        );
        let env = EnvOverrides::new();

        let models = CohereAdapter
            .fetch_models(&context(SECRET), &call(&transport, &env))
            .await
            .expect("models");

        assert_eq!(
            models
                .iter()
                .map(|model| model.id.as_str())
                .collect::<Vec<_>>(),
            vec!["command-a-03-2025", "chat-r-plus"]
        );
        assert_eq!(models[0].name, models[0].id, "`name` echoes the id");
        assert_eq!(models[0].provider, "cohere");
        assert_eq!(models[0].owned_by, None);
        assert_eq!(models[0].context_window, None);
        assert_eq!(models[0].created, None);
        assert_eq!(models[0].billing, None);
    }

    /// `index.ts:12`: a non-2xx status is an empty list, not an error — and the
    /// request was still sent.
    #[tokio::test]
    async fn fetch_models_returns_an_empty_list_for_a_non_2xx_status() {
        let transport = StubTransport::text(StatusCode::UNAUTHORIZED, "{\"message\":\"nope\"}");
        let env = EnvOverrides::new();

        let models = CohereAdapter
            .fetch_models(&context(SECRET), &call(&transport, &env))
            .await
            .expect("models");

        assert!(models.is_empty());
        assert_eq!(transport.sent().len(), 1);
    }

    /// A missing or `null` `models` is the `?? []` fallback (`index.ts:18`).
    #[tokio::test]
    async fn fetch_models_treats_a_missing_or_null_models_field_as_empty() {
        let env = EnvOverrides::new();
        for body in [serde_json::json!({}), serde_json::json!({ "models": null })] {
            let transport = StubTransport::json(StatusCode::OK, &body);
            let models = CohereAdapter
                .fetch_models(&context(SECRET), &call(&transport, &env))
                .await
                .expect("models");
            assert!(models.is_empty(), "{body}");
        }
    }

    /// `fetchModels` has no `try`/`catch` (`index.ts:7-21`), so a transport failure
    /// reaches the caller instead of degrading to an empty list.
    #[tokio::test]
    async fn fetch_models_propagates_a_transport_failure_and_an_undecodable_body() {
        let env = EnvOverrides::new();
        let unreachable = CohereAdapter
            .fetch_models(&context(SECRET), &call(&UnreachableTransport, &env))
            .await
            .expect_err("a transport failure is not an empty list");
        assert!(
            matches!(unreachable, HttpError::Transport(_)),
            "{unreachable}"
        );

        let transport = StubTransport::text(StatusCode::OK, "<html>");
        let invalid = CohereAdapter
            .fetch_models(&context(SECRET), &call(&transport, &env))
            .await
            .expect_err("an unparsable body is not an empty list");
        assert!(matches!(invalid, HttpError::InvalidBody(_)), "{invalid}");
    }

    /// Divergence 5, first half: the `TypeError`s of `index.ts:18-19`, with V8's
    /// wording.
    #[tokio::test]
    async fn fetch_models_reports_the_type_errors_the_source_would_throw() {
        let env = EnvOverrides::new();
        for (body, expected) in [
            (Value::Null, NULL_MODELS_DOCUMENT_MESSAGE),
            (
                serde_json::json!({ "models": {} }),
                MODELS_TYPE_ERROR_MESSAGE,
            ),
            (
                serde_json::json!({ "models": [{ "name": "m", "endpoints": {} }] }),
                ENDPOINTS_TYPE_ERROR_MESSAGE,
            ),
        ] {
            let transport = StubTransport::json(StatusCode::OK, &body);
            let error = CohereAdapter
                .fetch_models(&context(SECRET), &call(&transport, &env))
                .await
                .expect_err("the source throws here");
            assert_eq!(
                error,
                HttpError::InvalidBody(expected.to_string()),
                "{body}"
            );
        }
    }

    /// Divergence 7: `{ name: undefined }` has no `string` target in `FetchedModel`.
    #[tokio::test]
    async fn fetch_models_drops_a_model_without_a_string_name() {
        let transport = StubTransport::json(
            StatusCode::OK,
            &serde_json::json!({
                "models": [{ "endpoints": ["chat"] }, { "name": 7, "endpoints": ["chat"] }]
            }),
        );
        let env = EnvOverrides::new();

        let models = CohereAdapter
            .fetch_models(&context(SECRET), &call(&transport, &env))
            .await
            .expect("models");

        assert!(models.is_empty());
    }

    /// `index.ts:23-32`: the same endpoint, the success sentence verbatim.
    #[tokio::test]
    async fn test_connectivity_reports_the_models_list_as_reachable() {
        let transport = StubTransport::json(StatusCode::OK, &serde_json::json!({ "models": [] }));
        let env = EnvOverrides::new();

        let result = CohereAdapter
            .test_connectivity(&context(SECRET), &call(&transport, &env), None)
            .await;

        assert!(result.ok);
        assert_eq!(
            result.message,
            "Cohere connectivity verified (models list reachable)."
        );
        assert_eq!(result.rate_limits, None);
        assert_eq!(transport.sent()[0].timeout_ms, DEFAULT_REQUEST_TIMEOUT_MS);
        assert_eq!(
            transport.sent()[0].headers["authorization"],
            "Bearer cohere-secret"
        );
    }

    /// `index.ts:31` plus `parseErrorMessage` (`http.ts:50-69`), which is what
    /// `fetchJsonOk` applies here — the adapter's own error branch is only used by
    /// `dispatchGateway`.
    #[tokio::test]
    async fn test_connectivity_prefixes_the_message_it_got() {
        let env = EnvOverrides::new();

        let transport = StubTransport::json(
            StatusCode::UNAUTHORIZED,
            &serde_json::json!({ "message": "invalid api token" }),
        );
        let result = CohereAdapter
            .test_connectivity(&context(SECRET), &call(&transport, &env), None)
            .await;
        assert!(!result.ok);
        assert_eq!(
            result.message,
            "Cohere connectivity failed: invalid api token"
        );

        let unreachable = CohereAdapter
            .test_connectivity(
                &context(SECRET),
                &call(&UnreachableTransport, &env),
                Some("command-a-03-2025"),
            )
            .await;
        assert!(!unreachable.ok);
        assert_eq!(
            unreachable.message,
            "Cohere connectivity failed: No HTTP transport is configured."
        );
    }

    /// `index.ts:35-38`: every system message, joined with a newline, and the parts
    /// are never trimmed.
    #[test]
    fn build_system_message_joins_every_system_message() {
        assert_eq!(
            build_system_message(&request(
                "m",
                vec![
                    system("be terse"),
                    GatewayMessage::user("hi"),
                    system("and kind")
                ]
            )),
            "be terse\nand kind"
        );
        assert_eq!(
            build_system_message(&request("m", vec![GatewayMessage::user("hi")])),
            ""
        );
        // Empty system messages still contribute a separator, as `join` does.
        assert_eq!(
            build_system_message(&request("m", vec![system("a"), system("")])),
            "a\n"
        );
    }

    /// `index.ts:40-46`: `filter(!system).slice(0, -1)`, with only `assistant`
    /// preserved.
    #[test]
    fn build_chat_history_drops_the_last_turn_and_collapses_roles() {
        assert_eq!(
            build_chat_history(&request("m", vec![])),
            Vec::<Value>::new()
        );
        assert_eq!(
            build_chat_history(&request("m", vec![GatewayMessage::user("only")])),
            Vec::<Value>::new(),
            "a single-turn conversation has no history"
        );
        assert_eq!(
            build_chat_history(&request(
                "m",
                vec![
                    system("ignored"),
                    GatewayMessage::user("one"),
                    assistant("two"),
                    GatewayMessage::user("three")
                ]
            )),
            vec![
                serde_json::json!({ "role": "user", "content": "one" }),
                serde_json::json!({ "role": "assistant", "content": "two" })
            ]
        );
    }

    /// `index.ts:48-49`.
    #[test]
    fn last_user_message_is_the_last_user_turn_or_an_empty_string() {
        assert_eq!(
            last_user_message(&request(
                "m",
                vec![
                    GatewayMessage::user("one"),
                    assistant("two"),
                    GatewayMessage::user("three")
                ]
            )),
            "three"
        );
        assert_eq!(
            last_user_message(&request("m", vec![assistant("no user turn")])),
            ""
        );
    }

    /// The whole body of `index.ts:51-62`, including the duplication the source
    /// produces (`index.ts:40-46` keeps the last turn, `index.ts:56` appends it
    /// again) and the `stream: false` that is not read from the request.
    #[test]
    fn build_gateway_body_matches_the_v2_chat_body() {
        let mut request = request(
            "command-a-03-2025",
            vec![
                system("be terse"),
                GatewayMessage::user("one"),
                assistant("two"),
                GatewayMessage::user("three"),
            ],
        );
        request.stream = Some(true);

        assert_eq!(
            build_gateway_body(&request),
            serde_json::json!({
                "model": "command-a-03-2025",
                "messages": [
                    { "role": "system", "content": "be terse" },
                    { "role": "user", "content": "one" },
                    { "role": "assistant", "content": "two" },
                    { "role": "user", "content": "three" }
                ],
                "stream": false
            })
        );
    }

    /// `index.ts:51-62` key order, and the two different optionality tests:
    /// `if (max_tokens)` is a truthiness test (`0` is dropped) while
    /// `temperature !== undefined` keeps `0`.
    #[test]
    fn build_gateway_body_keeps_the_key_order_and_the_two_optionality_tests() {
        let mut request = request("m", vec![GatewayMessage::user("hi")]);
        assert_eq!(
            serde_json::to_string(&build_gateway_body(&request)).expect("serialize"),
            r#"{"model":"m","messages":[{"role":"user","content":"hi"}],"stream":false}"#
        );

        request.max_tokens = Some(0);
        request.temperature = Some(0.0);
        assert_eq!(
            serde_json::to_string(&build_gateway_body(&request)).expect("serialize"),
            r#"{"model":"m","messages":[{"role":"user","content":"hi"}],"stream":false,"temperature":0.0}"#
        );

        request.max_tokens = Some(64);
        request.temperature = Some(0.5);
        assert_eq!(
            serde_json::to_string(&build_gateway_body(&request)).expect("serialize"),
            r#"{"model":"m","messages":[{"role":"user","content":"hi"}],"stream":false,"max_tokens":64,"temperature":0.5}"#
        );
    }

    /// A conversation without a system turn still ends with the appended — empty —
    /// user message, exactly like `index.ts:56`.
    #[test]
    fn build_gateway_body_appends_an_empty_user_turn_when_there_is_none() {
        assert_eq!(
            build_gateway_body(&request("m", vec![assistant("only")])),
            serde_json::json!({
                "model": "m",
                "messages": [{ "role": "user", "content": "" }],
                "stream": false
            })
        );
    }

    /// `index.ts:64-75`: `POST /v2/chat`, JSON body, both headers, and the
    /// hard-coded 60 s that `request.tools` and `MODEL_HUB_GATEWAY_TIMEOUT_MS`
    /// cannot change.
    #[tokio::test]
    async fn dispatch_gateway_posts_the_v2_chat_body_with_a_hard_coded_timeout() {
        let transport = StubTransport::json(
            StatusCode::OK,
            &serde_json::json!({ "message": { "content": [{ "type": "text", "text": "hi" }] } }),
        );
        let env = EnvOverrides::new()
            .with("MODEL_HUB_GATEWAY_TIMEOUT_MS", "300000")
            .with("MODEL_HUB_GATEWAY_EXEC_TIMEOUT_MS", "300000");
        let mut request = request("command-a-03-2025", vec![GatewayMessage::user("hi")]);
        request.tools = Some(vec![serde_json::json!({ "type": "function" })]);

        CohereAdapter
            .dispatch_gateway(
                &context(SECRET),
                &call(&transport, &env),
                &request,
                &DispatchOptions::default(),
            )
            .await
            .expect("dispatch");

        let sent = transport.sent();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].method.as_str(), "POST");
        assert_eq!(sent[0].url, "https://api.cohere.com/v2/chat");
        assert_eq!(sent[0].headers["authorization"], "Bearer cohere-secret");
        assert_eq!(sent[0].headers["content-type"], "application/json");
        assert_eq!(sent[0].timeout_ms, DISPATCH_TIMEOUT_MS);
        assert_eq!(
            transport.sent_body(),
            serde_json::json!({
                "model": "command-a-03-2025",
                "messages": [{ "role": "user", "content": "hi" }],
                "stream": false
            }),
            "`tools` never reach the v2 body"
        );
    }

    /// Divergence 2: the TypeScript call passes three arguments (`index.ts:64-75`),
    /// so a caller's abort signal is not forwarded.
    #[tokio::test]
    async fn dispatch_gateway_does_not_forward_the_abort_signal() {
        let transport = StubTransport::json(
            StatusCode::OK,
            &serde_json::json!({ "message": { "content": [] } }),
        );
        let env = EnvOverrides::new();
        let signal = AbortSignal::new();
        signal.abort();

        let response = CohereAdapter
            .dispatch_gateway(
                &context(SECRET),
                &call(&transport, &env),
                &request("m", vec![GatewayMessage::user("hi")]),
                &DispatchOptions {
                    abort: Some(signal),
                    ..DispatchOptions::default()
                },
            )
            .await
            .expect("dispatch");

        assert!(response.ok);
        assert!(transport.sent()[0].abort.is_none());
    }

    /// `index.ts:104-121`: text from the `text` blocks, usage from `usage.tokens`,
    /// and `model` echoed from the request rather than read from the answer.
    #[tokio::test]
    async fn dispatch_gateway_reads_the_content_blocks_and_the_token_usage() {
        let transport = StubTransport::json(
            StatusCode::OK,
            &serde_json::json!({
                "id": "abc",
                "model": "a-different-model",
                "message": {
                    "role": "assistant",
                    "content": [
                        { "type": "thinking", "text": "ignored" },
                        { "type": "text", "text": "Hello " },
                        { "type": "text", "text": "world" },
                        { "type": "text" }
                    ]
                },
                "usage": { "tokens": { "input_tokens": 7, "output_tokens": 3 } }
            }),
        );
        let env = EnvOverrides::new();

        let response = CohereAdapter
            .dispatch_gateway(
                &context(SECRET),
                &call(&transport, &env),
                &request("command-a-03-2025", vec![GatewayMessage::user("hi")]),
                &DispatchOptions::default(),
            )
            .await
            .expect("dispatch");

        assert!(response.ok, "{response:?}");
        assert_eq!(response.text, "Hello world");
        assert_eq!(response.model, "command-a-03-2025");
        assert_eq!(response.provider, "cohere");
        assert_eq!(response.error, None);
        assert_eq!(
            response.usage,
            Some(GatewayUsage {
                prompt_tokens: 7,
                completion_tokens: 3,
                total_tokens: 10,
            })
        );
    }

    /// `index.ts:110` and `index.ts:116`: `usage.tokens ?? usage.billed_units`, then
    /// a truthiness test on the result.
    #[test]
    fn extract_usage_prefers_tokens_and_falls_back_to_billed_units() {
        assert_eq!(
            extract_usage(&serde_json::json!({
                "usage": { "billed_units": { "input_tokens": 2, "output_tokens": 1 } }
            })),
            Some(GatewayUsage {
                prompt_tokens: 2,
                completion_tokens: 1,
                total_tokens: 3,
            })
        );
        // A `null` `tokens` is nullish, so the fallback applies.
        assert_eq!(
            extract_usage(&serde_json::json!({
                "usage": { "tokens": null, "billed_units": { "input_tokens": 4 } }
            })),
            Some(GatewayUsage {
                prompt_tokens: 4,
                completion_tokens: 0,
                total_tokens: 4,
            })
        );
        // An empty block is truthy in JavaScript, so all three fields are 0.
        assert_eq!(
            extract_usage(&serde_json::json!({ "usage": { "tokens": {} } })),
            Some(GatewayUsage {
                prompt_tokens: 0,
                completion_tokens: 0,
                total_tokens: 0,
            })
        );
        // `false` and `0` are falsy, so `usage ? … : undefined` drops them.
        assert_eq!(
            extract_usage(&serde_json::json!({ "usage": { "tokens": false } })),
            None
        );
        assert_eq!(
            extract_usage(&serde_json::json!({ "usage": { "tokens": 0 } })),
            None
        );
        assert_eq!(extract_usage(&serde_json::json!({})), None);
        assert_eq!(extract_usage(&serde_json::json!({ "usage": null })), None);
        // A `null` count is `?? 0`, and a non-integer count has no `i64` target
        // (divergence 4).
        assert_eq!(
            extract_usage(&serde_json::json!({
                "usage": { "tokens": { "input_tokens": null, "output_tokens": 1.5 } }
            })),
            Some(GatewayUsage {
                prompt_tokens: 0,
                completion_tokens: 0,
                total_tokens: 0,
            })
        );
    }

    /// `index.ts:104-108`: the `?.` chain makes a missing `message`/`content` the
    /// `?? ''` fallback, and only `type: 'text'` blocks contribute.
    #[test]
    fn extract_text_follows_the_optional_chains() {
        assert_eq!(extract_text(&serde_json::json!({})), Ok(String::new()));
        assert_eq!(
            extract_text(&serde_json::json!({ "message": null })),
            Ok(String::new())
        );
        assert_eq!(
            extract_text(&serde_json::json!({ "message": { "content": null } })),
            Ok(String::new())
        );
        assert_eq!(
            extract_text(&serde_json::json!({ "message": { "content": [] } })),
            Ok(String::new())
        );
        assert_eq!(
            extract_text(&serde_json::json!({
                "message": { "content": [{ "type": "text", "text": null }, { "type": "text" }] }
            })),
            Ok(String::new())
        );
        // A non-object block is dropped by the `type` comparison, not by a throw.
        assert_eq!(
            extract_text(&serde_json::json!({
                "message": { "content": [7, "chat", { "type": "text", "text": "kept" }] }
            })),
            Ok("kept".to_string())
        );
        // Divergence 6: `join('')` would stringify the number into `"5"`.
        assert_eq!(
            extract_text(&serde_json::json!({
                "message": { "content": [{ "type": "text", "text": 5 }] }
            })),
            Ok(String::new())
        );
    }

    /// Divergence 5, second half: the `TypeError`s of `index.ts:105-106`.
    #[test]
    fn extract_text_reports_the_type_errors_the_source_would_throw() {
        assert_eq!(
            extract_text(&Value::Null),
            Err(NULL_MESSAGE_DOCUMENT_MESSAGE.to_string())
        );
        for content in [
            serde_json::json!({}),
            serde_json::json!("abc"),
            serde_json::json!(7),
        ] {
            assert_eq!(
                extract_text(&serde_json::json!({ "message": { "content": content } })),
                Err(CONTENT_TYPE_ERROR_MESSAGE.to_string()),
                "{content}"
            );
        }
        assert_eq!(
            extract_text(&serde_json::json!({ "message": { "content": [null] } })),
            Err(BLOCK_TYPE_ERROR_MESSAGE.to_string())
        );
    }

    /// `index.ts:77-94`: the message of a JSON error body wins, then the raw body
    /// wins over the status line.
    #[test]
    fn error_message_for_failed_response_follows_the_sources_precedence() {
        let json_body = HttpResponse::json(
            StatusCode::BAD_REQUEST,
            &serde_json::json!({ "message": "invalid request" }),
        );
        assert_eq!(
            error_message_for_failed_response(&json_body),
            "invalid request"
        );

        // `??` is a nullish test: an empty message is a value, so it survives.
        let empty_message = HttpResponse::json(
            StatusCode::BAD_REQUEST,
            &serde_json::json!({ "message": "" }),
        );
        assert_eq!(error_message_for_failed_response(&empty_message), "");

        // A `null` message falls back to the raw body.
        let null_message = HttpResponse::json(
            StatusCode::BAD_REQUEST,
            &serde_json::json!({ "message": null }),
        );
        assert_eq!(
            error_message_for_failed_response(&null_message),
            "{\"message\":null}"
        );

        // A non-string message has no `String` target (divergence 3).
        let number_message = HttpResponse::json(
            StatusCode::BAD_REQUEST,
            &serde_json::json!({ "message": 42 }),
        );
        assert_eq!(
            error_message_for_failed_response(&number_message),
            "{\"message\":42}"
        );

        // Unparsable bodies are used verbatim and untrimmed.
        let text_body = HttpResponse::new(
            StatusCode::BAD_GATEWAY,
            HeaderMap::new(),
            "  upstream died  ",
        );
        assert_eq!(
            error_message_for_failed_response(&text_body),
            "  upstream died  "
        );

        // Only an *empty* body reaches the status line; a blank one does not.
        let empty_body = HttpResponse::new(StatusCode::INTERNAL_SERVER_ERROR, HeaderMap::new(), "");
        assert_eq!(error_message_for_failed_response(&empty_body), "HTTP 500");
        let whitespace_body =
            HttpResponse::new(StatusCode::INTERNAL_SERVER_ERROR, HeaderMap::new(), " ");
        assert_eq!(error_message_for_failed_response(&whitespace_body), " ");
    }

    /// `index.ts:87-93`: a failure is a `GatewayResponse`, not an `Err`.
    #[tokio::test]
    async fn dispatch_gateway_reports_an_http_error_as_a_failed_response() {
        let transport = StubTransport::json(
            StatusCode::NOT_FOUND,
            &serde_json::json!({ "message": "gone" }),
        );
        let env = EnvOverrides::new();

        let response = CohereAdapter
            .dispatch_gateway(
                &context(SECRET),
                &call(&transport, &env),
                &request("command-a-03-2025", vec![GatewayMessage::user("hi")]),
                &DispatchOptions::default(),
            )
            .await
            .expect("an HTTP status is not a transport failure");

        assert!(!response.ok);
        assert_eq!(response.text, "");
        assert_eq!(response.error.as_deref(), Some("gone"));
        assert_eq!(response.model, "command-a-03-2025");
        assert_eq!(response.provider, "cohere");
        assert_eq!(response.usage, None);
    }

    /// Divergence 1: `index.ts:34-124` has no `try`/`catch`, so a transport failure
    /// and an undecodable 2xx body escape instead of becoming `{ ok: false }`.
    #[tokio::test]
    async fn dispatch_gateway_propagates_transport_and_body_failures() {
        let env = EnvOverrides::new();
        let request = request("m", vec![GatewayMessage::user("hi")]);

        let unreachable = CohereAdapter
            .dispatch_gateway(
                &context(SECRET),
                &call(&UnreachableTransport, &env),
                &request,
                &DispatchOptions::default(),
            )
            .await
            .expect_err("a transport failure is not a failed response");
        assert!(
            matches!(unreachable, HttpError::Transport(_)),
            "{unreachable}"
        );

        let transport = StubTransport::text(StatusCode::OK, "<html>nope</html>");
        let invalid = CohereAdapter
            .dispatch_gateway(
                &context(SECRET),
                &call(&transport, &env),
                &request,
                &DispatchOptions::default(),
            )
            .await
            .expect_err("an unparsable body is not a failed response");
        assert!(matches!(invalid, HttpError::InvalidBody(_)), "{invalid}");

        let transport = StubTransport::json(
            StatusCode::OK,
            &serde_json::json!({ "message": { "content": {} } }),
        );
        let type_error = CohereAdapter
            .dispatch_gateway(
                &context(SECRET),
                &call(&transport, &env),
                &request,
                &DispatchOptions::default(),
            )
            .await
            .expect_err("the source throws a TypeError here");
        assert_eq!(
            type_error,
            HttpError::InvalidBody(CONTENT_TYPE_ERROR_MESSAGE.to_string())
        );
    }

    /// The adapter reports its own id, which is the key the registry uses.
    #[test]
    fn the_adapter_is_the_cohere_provider() {
        assert_eq!(CohereAdapter.id(), "cohere");
    }
}
