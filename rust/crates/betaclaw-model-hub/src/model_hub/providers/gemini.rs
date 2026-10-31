//! Port of `src/server/model-hub/Models/gemini/index.ts`.
//!
//! # Why this adapter is REST and not the SDK
//!
//! The TypeScript adapter builds its request with `@google/genai`
//! (`new GoogleGenAI({ apiKey }).models.generateContent({ model, contents, config })`).
//! That SDK has no Rust equivalent in this workspace, and adding one would pull a
//! large, network-owning dependency into `betaclaw-core`, which deliberately owns
//! no HTTP client. The port therefore speaks the documented REST surface the SDK
//! compiles down to:
//!
//! | TypeScript | REST |
//! | --- | --- |
//! | `new GoogleGenAI({ apiKey })` | `x-goog-api-key: <secret>` header |
//! | `ai.models.generateContent({ model, contents, config })` | `POST {API_BASE_URL}/models/{model}:generateContent` |
//! | model list | `GET {API_BASE_URL}/models?key={secret}&pageSize=100` |
//!
//! The request side is pinned by the recorded traffic fixture
//! (`rust/crates/betaclaw-gateway/tests/fixtures/gemini/exchanges.json`, produced by
//! `pnpm run fixtures:gemini-traffic`). The replay test in the gateway crate drives
//! this adapter with the fixture responses and asserts the requests on the URL and
//! headers exactly and on the JSON body semantically (object key order is not a
//! wire contract).
//!
//! # Deliberate divergences
//!
//! - `dispatchGateway` in TypeScript wraps *everything* in `try { … } catch { }`
//!   and turns any failure — including a transport failure — into
//!   `{ ok: false, error }`. The shared OpenAI-compatible layer instead lets a
//!   transport error escape. The port follows the TypeScript adapter, so a Gemini
//!   transport failure becomes [`GatewayResponse::failure`] rather than an
//!   [`HttpError`]: `dispatch_gateway` therefore always returns `Ok`.
//! - `contents: 'Ping'` in `testConnectivity` is normalised by the SDK to
//!   `[{ parts: [{ text: 'Ping' }], role: 'user' }]`; the port normalises it the
//!   same way before serialising.
//! - The SDK always appends `generationConfig` when a `config` object is passed,
//!   even when empty. `dispatchGateway` therefore always emits `generationConfig`;
//!   `testConnectivity`, which passes no config, never does.

use serde_json::{json, Map, Value};

use crate::model_hub::http::{
    fetch_with_timeout, parse_error_message, BoxFuture, HttpError, HttpRequest,
};
use crate::model_hub::openai_compatible::DispatchOptions;
use crate::model_hub::types::{
    ConnectivityResult, FetchedModel, GatewayFunctionCall, GatewayMessage, GatewayRequest,
    GatewayResponse, GatewayRole, GatewayUsage, ProviderExecutionContext,
};

use super::{ProviderAdapter, ProviderCall};

/// `https://generativelanguage.googleapis.com/v1beta` — the origin plus `v1beta`
/// prefix used by every request of `gemini/index.ts`.
pub const API_BASE_URL: &str = "https://generativelanguage.googleapis.com/v1beta";

/// `'gemini-2.5-flash'` — the third fallback of
/// `options.model || provider.defaultModels[0] || 'gemini-2.5-flash'`
/// (`gemini/index.ts:186`).
pub const FALLBACK_MODEL: &str = "gemini-2.5-flash";

/// `'Gemini connectivity verified.'` from `gemini/index.ts:193`.
pub const CONNECTIVITY_OK: &str = "Gemini connectivity verified.";
/// `'Gemini returned no content.'` from `gemini/index.ts:193`.
pub const CONNECTIVITY_NO_CONTENT: &str = "Gemini returned no content.";
/// `'Gemini connectivity failed'` from `gemini/index.ts:196`.
pub const CONNECTIVITY_FAILED: &str = "Gemini connectivity failed";

/// `encodeURIComponent` from JavaScript.
///
/// The unreserved set is `A-Za-z0-9` plus `- _ . ! ~ * ' ( )`; every other byte of
/// the UTF-8 encoding becomes `%XX`. The Gemini key is a token that usually needs
/// no escaping, but reproducing the function keeps the URL byte-identical for a
/// key that does.
pub fn encode_uri_component(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'-'
            | b'_'
            | b'.'
            | b'!'
            | b'~'
            | b'*'
            | b'\''
            | b'('
            | b')' => out.push(byte as char),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// The model-list URL of `gemini/index.ts:171`.
pub fn models_url(secret: &str) -> String {
    format!(
        "{API_BASE_URL}/models?key={}&pageSize=100",
        encode_uri_component(secret)
    )
}

/// The `generateContent` URL of `gemini/index.ts:236`.
pub fn generate_content_url(model: &str) -> String {
    format!("{API_BASE_URL}/models/{model}:generateContent")
}

/// `mapOpenAiTypeToGemini` from `gemini/index.ts:51-66`.
///
/// `String(type || '').toLowerCase()` — a non-string JSON value stringifies first,
/// so `true` becomes `"true"` and falls through to `STRING`.
pub fn map_openai_type_to_gemini(value: Option<&Value>) -> &'static str {
    let raw = match value {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Bool(flag)) => flag.to_string(),
        Some(Value::Number(number)) => number.to_string(),
        _ => String::new(),
    };
    match raw.to_lowercase().as_str() {
        "number" => "NUMBER",
        "integer" => "INTEGER",
        "boolean" => "BOOLEAN",
        "array" => "ARRAY",
        "object" => "OBJECT",
        _ => "STRING",
    }
}

/// `normalizeGeminiTools` from `gemini/index.ts:68-152`.
///
/// Each returned entry is `{ functionDeclarations: [ … ] }`. A tool that already
/// carries a non-empty `functionDeclarations` array is passed through unchanged; an
/// OpenAI-style `{ type: 'function', function: { … } }` tool is rewritten into the
/// Gemini declaration shape. Non-objects, arrays and tools without a function name
/// are dropped, exactly like the `continue`s in the source.
pub fn normalize_gemini_tools(raw_tools: &[Value]) -> Vec<Value> {
    let mut normalized = Vec::new();

    for raw_tool in raw_tools {
        let Some(tool) = raw_tool.as_object() else {
            continue;
        };

        // `Array.isArray(tool.functionDeclarations) && length > 0`
        if tool
            .get("functionDeclarations")
            .and_then(Value::as_array)
            .is_some_and(|declarations| !declarations.is_empty())
        {
            normalized.push(Value::Object(tool.clone()));
            continue;
        }

        // `tool.type !== 'function' || !tool.function || typeof tool.function.name !== 'string'`
        if tool.get("type").and_then(Value::as_str) != Some("function") {
            continue;
        }
        let Some(function) = tool.get("function").and_then(Value::as_object) else {
            continue;
        };
        let Some(name) = function.get("name").and_then(Value::as_str) else {
            continue;
        };

        let raw_params = function
            .get("parameters")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let raw_properties = raw_params
            .get("properties")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();

        let mut properties = Map::new();
        for (property_name, property) in &raw_properties {
            let Some(typed_property) = property.as_object() else {
                continue;
            };
            let mut next_property = Map::new();
            next_property.insert(
                "type".to_string(),
                Value::String(map_openai_type_to_gemini(typed_property.get("type")).to_string()),
            );
            if let Some(description) = typed_property.get("description").and_then(Value::as_str) {
                next_property.insert(
                    "description".to_string(),
                    Value::String(description.to_string()),
                );
            }
            if let Some(values) = typed_property.get("enum").and_then(Value::as_array) {
                let enum_values: Vec<Value> = values
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(|value| Value::String(value.to_string()))
                    .collect();
                if !enum_values.is_empty() {
                    next_property.insert("enum".to_string(), Value::Array(enum_values));
                }
            }
            properties.insert(property_name.clone(), Value::Object(next_property));
        }

        let required: Vec<Value> = raw_params
            .get("required")
            .and_then(Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(Value::as_str)
                    .map(|value| Value::String(value.to_string()))
                    .collect()
            })
            .unwrap_or_default();

        let mut declaration = Map::new();
        declaration.insert("name".to_string(), Value::String(name.to_string()));
        if let Some(description) = function.get("description").and_then(Value::as_str) {
            declaration.insert(
                "description".to_string(),
                Value::String(description.to_string()),
            );
        }
        declaration.insert(
            "parameters".to_string(),
            json!({
                "type": map_openai_type_to_gemini(raw_params.get("type")),
                "properties": Value::Object(properties),
                "required": required,
            }),
        );

        normalized.push(json!({
            "functionDeclarations": [Value::Object(declaration)],
        }));
    }

    normalized
}

/// The SDK's `GenerateContentResponse.text` getter.
///
/// The getter concatenates the `text` parts of every candidate; a candidate
/// without `content.parts`, or a part without a string `text`, contributes
/// nothing (`if (part.text)` is falsy for an empty string too, so `""` is skipped
/// but concatenation is unaffected).
pub fn extract_gemini_text(result: &Value) -> String {
    let mut text = String::new();
    let Some(candidates) = result.get("candidates").and_then(Value::as_array) else {
        return text;
    };
    for candidate in candidates {
        let Some(parts) = candidate
            .get("content")
            .and_then(|content| content.get("parts"))
            .and_then(Value::as_array)
        else {
            continue;
        };
        for part in parts {
            if let Some(chunk) = part.get("text").and_then(Value::as_str) {
                text.push_str(chunk);
            }
        }
    }
    text
}

/// `extractGeminiFunctionCalls` from `gemini/index.ts:30-49`.
///
/// A non-empty top-level `functionCalls` array wins; otherwise the first
/// candidate's parts are mapped through `part.functionCall`, keeping only entries
/// with a truthy `name`.
pub fn extract_gemini_function_calls(result: &Value) -> Vec<GatewayFunctionCall> {
    if let Some(calls) = result.get("functionCalls").and_then(Value::as_array) {
        if !calls.is_empty() {
            return calls.iter().map(to_function_call).collect();
        }
    }

    result
        .get("candidates")
        .and_then(Value::as_array)
        .and_then(|candidates| candidates.first())
        .and_then(|candidate| candidate.get("content"))
        .and_then(|content| content.get("parts"))
        .and_then(Value::as_array)
        .map(|parts| {
            parts
                .iter()
                .filter_map(|part| part.get("functionCall"))
                .filter(|call| call.get("name").and_then(Value::as_str).is_some())
                .map(to_function_call)
                .collect()
        })
        .unwrap_or_default()
}

/// One `{ name, args? }` pair. The caller has already guaranteed a string `name`.
fn to_function_call(call: &Value) -> GatewayFunctionCall {
    GatewayFunctionCall {
        name: call
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        args: call.get("args").cloned(),
    }
}

/// `result.usageMetadata` → `GatewayResponse['usage']`
/// (`gemini/index.ts:268-281`).
///
/// Absent metadata yields `None`; present metadata always yields a usage with the
/// three counts defaulting to `0`, which is what `usage.promptTokenCount ?? 0`
/// does.
pub fn extract_gemini_usage(result: &Value) -> Option<GatewayUsage> {
    let usage = result.get("usageMetadata")?;
    Some(GatewayUsage {
        prompt_tokens: token_count(usage.get("promptTokenCount")),
        completion_tokens: token_count(usage.get("candidatesTokenCount")),
        total_tokens: token_count(usage.get("totalTokenCount")),
    })
}

/// `value ?? 0` for a token count that the API may omit.
fn token_count(value: Option<&Value>) -> i64 {
    value.and_then(Value::as_i64).unwrap_or(0)
}

/// The `contents` array of `dispatchGateway` (`gemini/index.ts:217-222`).
///
/// System messages are dropped here: their text travels in `systemInstruction`.
/// An assistant turn becomes the Gemini `model` role.
pub fn build_gemini_contents(messages: &[GatewayMessage]) -> Vec<Value> {
    messages
        .iter()
        .filter(|message| message.role != GatewayRole::System)
        .map(|message| {
            let role = if message.role == GatewayRole::Assistant {
                "model"
            } else {
                "user"
            };
            json!({
                "parts": [{ "text": message.content }],
                "role": role,
            })
        })
        .collect()
}

/// The `systemInstruction` string of `gemini/index.ts:209-215`:
/// `[request.systemInstruction, systemFromMessages].filter(Boolean).join('\n')`.
///
/// The filter drops `undefined` and the empty string alike, so an empty explicit
/// instruction does not introduce a leading newline.
pub fn build_system_instruction(request: &GatewayRequest) -> String {
    let explicit = request.system_instruction.as_deref().unwrap_or("");
    let from_messages = request
        .messages
        .iter()
        .filter(|message| message.role == GatewayRole::System)
        .map(|message| message.content.as_str())
        .collect::<Vec<_>>()
        .join("\n");

    [explicit, from_messages.as_str()]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

/// The `generationConfig` object of `gemini/index.ts:224-234`.
///
/// `dispatchGateway` always passes a `config` object to the SDK, and the SDK
/// always emits `generationConfig` — even as `{}` in a request that only carries
/// tools (see the recorded fixture). The field guards follow the source:
/// `if (request.max_tokens)` skips `0`, `if (request.temperature !== undefined)`
/// keeps `0.0`, and `if (request.responseMimeType)` skips the empty string.
pub fn build_generation_config(request: &GatewayRequest) -> Value {
    let mut config = Map::new();
    if let Some(max_tokens) = request.max_tokens.filter(|value| *value != 0) {
        config.insert("maxOutputTokens".to_string(), json!(max_tokens));
    }
    if let Some(temperature) = request.temperature {
        config.insert("temperature".to_string(), json!(temperature));
    }
    if let Some(mime_type) = request
        .response_mime_type
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        config.insert("responseMimeType".to_string(), json!(mime_type));
    }
    Value::Object(config)
}

/// The full `generateContent` body of `dispatchGateway`
/// (`gemini/index.ts:217-240`).
///
/// Key order matches the recorded fixture (`contents`, `systemInstruction?`,
/// `tools?`, `generationConfig`) so the replay test can diff the serialised body
/// as a string when it wants to.
pub fn build_gateway_body(request: &GatewayRequest) -> Value {
    let mut body = Map::new();
    body.insert(
        "contents".to_string(),
        Value::Array(build_gemini_contents(&request.messages)),
    );

    let system_instruction = build_system_instruction(request);
    if !system_instruction.is_empty() {
        body.insert(
            "systemInstruction".to_string(),
            json!({
                "parts": [{ "text": system_instruction }],
                "role": "user",
            }),
        );
    }

    if let Some(tools) = request.tools.as_deref().filter(|tools| !tools.is_empty()) {
        let normalized = normalize_gemini_tools(tools);
        if !normalized.is_empty() {
            body.insert("tools".to_string(), Value::Array(normalized));
        }
    }

    body.insert(
        "generationConfig".to_string(),
        build_generation_config(request),
    );
    Value::Object(body)
}

/// The `testConnectivity` body. `generateContent({ model, contents: 'Ping' })`
/// passes no config, so the SDK emits no `generationConfig`.
pub fn build_ping_body() -> Value {
    json!({
        "contents": [{ "parts": [{ "text": "Ping" }], "role": "user" }],
    })
}

/// `json.models ?? []` filtered to `models/gemini*` (`gemini/index.ts:176-196`).
///
/// `model.name.replace('models/', '')` replaces the first occurrence only, which is
/// what `replacen(.., 1)` reproduces. `name` falls back to the id when
/// `displayName` is absent or empty.
fn parse_models(json: &Value, provider_id: &str) -> Vec<FetchedModel> {
    json.get("models")
        .and_then(Value::as_array)
        .map(|models| {
            models
                .iter()
                .filter_map(|model| {
                    let raw_name = model.get("name").and_then(Value::as_str)?;
                    if !raw_name.starts_with("models/gemini") {
                        return None;
                    }
                    let id = raw_name.replacen("models/", "", 1);
                    let display_name = model
                        .get("displayName")
                        .and_then(Value::as_str)
                        .filter(|value| !value.is_empty());
                    Some(FetchedModel {
                        name: display_name.unwrap_or(id.as_str()).to_string(),
                        id,
                        provider: provider_id.to_string(),
                        owned_by: None,
                        context_window: model.get("inputTokenLimit").and_then(Value::as_f64),
                        created: None,
                        billing: None,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// `geminiProviderAdapter` from `gemini/index.ts:166-296`.
#[derive(Debug, Clone, Copy, Default)]
pub struct GeminiAdapter;

impl ProviderAdapter for GeminiAdapter {
    fn id(&self) -> &'static str {
        "gemini"
    }

    fn fetch_models<'a>(
        &'a self,
        context: &'a ProviderExecutionContext,
        call: &'a ProviderCall<'_>,
    ) -> BoxFuture<'a, Result<Vec<FetchedModel>, HttpError>> {
        Box::pin(async move {
            let request = HttpRequest::get(models_url(&context.secret));
            let response = fetch_with_timeout(call.transport, request).await?;
            if !response.is_ok() {
                return Ok(Vec::new());
            }
            let json: Value = serde_json::from_str(&response.body)
                .map_err(|error| HttpError::InvalidBody(error.to_string()))?;
            Ok(parse_models(&json, self.id()))
        })
    }

    fn test_connectivity<'a>(
        &'a self,
        context: &'a ProviderExecutionContext,
        call: &'a ProviderCall<'_>,
        model: Option<&'a str>,
    ) -> BoxFuture<'a, ConnectivityResult> {
        Box::pin(async move {
            // `options.model || provider.defaultModels[0] || 'gemini-2.5-flash'`.
            let model_name = model
                .filter(|name| !name.is_empty())
                .map(str::to_string)
                .or_else(|| context.provider.default_models.first().cloned())
                .unwrap_or_else(|| FALLBACK_MODEL.to_string());

            let request = HttpRequest::post(generate_content_url(&model_name))
                .header("content-type", "application/json")
                .header("x-goog-api-key", &context.secret)
                .json_body(&build_ping_body());

            match fetch_with_timeout(call.transport, request).await {
                Ok(response) if !response.is_ok() => {
                    ConnectivityResult::failed(parse_error_message(&response))
                }
                Ok(response) => match serde_json::from_str::<Value>(&response.body) {
                    Ok(json) => {
                        let text = extract_gemini_text(&json);
                        if text.trim().is_empty() {
                            ConnectivityResult {
                                ok: false,
                                message: CONNECTIVITY_NO_CONTENT.to_string(),
                                rate_limits: None,
                            }
                        } else {
                            ConnectivityResult::ok(CONNECTIVITY_OK)
                        }
                    }
                    Err(error) => ConnectivityResult::failed(error.to_string()),
                },
                Err(error) => ConnectivityResult::failed(error.to_string()),
            }
        })
    }

    fn dispatch_gateway<'a>(
        &'a self,
        context: &'a ProviderExecutionContext,
        call: &'a ProviderCall<'_>,
        request: &'a GatewayRequest,
        options: &'a DispatchOptions,
    ) -> BoxFuture<'a, Result<GatewayResponse, HttpError>> {
        Box::pin(async move {
            let mut http_request = HttpRequest::post(generate_content_url(&request.model))
                .header("content-type", "application/json")
                .header("x-goog-api-key", &context.secret)
                .json_body(&build_gateway_body(request));
            if let Some(abort) = &options.abort {
                http_request = http_request.abort(abort.clone());
            }

            // `try { … } catch { }` — the adapter never lets an error escape, so a
            // transport failure is reported as a failed gateway response (see the
            // module header). The `Err` variant is therefore never returned.
            match fetch_with_timeout(call.transport, http_request).await {
                Ok(response) if !response.is_ok() => Ok(GatewayResponse::failure(
                    request.model.clone(),
                    self.id(),
                    parse_error_message(&response),
                )),
                Ok(response) => match serde_json::from_str::<Value>(&response.body) {
                    Ok(json) => {
                        let function_calls = extract_gemini_function_calls(&json);
                        let mut result = GatewayResponse::success(
                            extract_gemini_text(&json),
                            request.model.clone(),
                            self.id(),
                        );
                        result.usage = extract_gemini_usage(&json);
                        result.function_calls =
                            (!function_calls.is_empty()).then_some(function_calls);
                        Ok(result)
                    }
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

/// The recorded exchanges of
/// `rust/crates/betaclaw-gateway/tests/fixtures/gemini/exchanges.json`.
///
/// They are inlined here so the pure helpers can be tested without a filesystem
/// read; the file itself is replayed by the gateway integration test
/// (`tests/gemini_fixture.rs`), which is the parity oracle.
#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use http::StatusCode;

    use super::*;
    use crate::model_hub::env::EnvOverrides;
    use crate::model_hub::http::{HttpResponse, HttpTransport, UnreachableTransport};
    use crate::model_hub::openai_compatible::NOOP_ATTACHMENT_STORE;
    use crate::model_hub::provider_catalog::find_provider;
    use crate::model_hub::repository::encrypted_secret_input;
    use crate::model_hub::types::{ProviderAccountRecord, ProviderAuthMethod};

    /// The secret the recorder used (`fixtures:gemini-traffic`).
    const SECRET: &str = "parity-not-a-real-key";

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

    fn call<'a>(transport: &'a StubTransport, env: &'a EnvOverrides) -> ProviderCall<'a> {
        ProviderCall {
            transport,
            attachments: &NOOP_ATTACHMENT_STORE,
            env,
        }
    }

    fn context(secret: &str) -> ProviderExecutionContext {
        ProviderExecutionContext {
            provider: find_provider("gemini")
                .expect("gemini is in the catalog")
                .clone(),
            account: ProviderAccountRecord {
                id: "acc-1".to_string(),
                provider_id: "gemini".to_string(),
                label: "gemini".to_string(),
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

    fn gateway_request() -> GatewayRequest {
        GatewayRequest::new("gemini-2.5-flash", vec![GatewayMessage::user("Say pong")])
    }

    /// `https://generativelanguage.googleapis.com/v1beta/models?key=<secret>&pageSize=100`
    /// — the URL of the `fetchModels ok` exchange.
    #[test]
    fn models_url_matches_the_recorded_request() {
        assert_eq!(
            models_url(SECRET),
            "https://generativelanguage.googleapis.com/v1beta/models?key=parity-not-a-real-key&pageSize=100"
        );
    }

    /// `encodeURIComponent` leaves the unreserved set and escapes everything else
    /// as upper-case `%XX`.
    #[test]
    fn encode_uri_component_follows_the_javascript_unreserved_set() {
        assert_eq!(
            encode_uri_component("aZ0-_.!~*'()"),
            "aZ0-_.!~*'()",
            "the unreserved set survives"
        );
        assert_eq!(encode_uri_component("a/b+c=d&e"), "a%2Fb%2Bc%3Dd%26e");
        // A multi-byte character escapes per UTF-8 byte.
        assert_eq!(encode_uri_component("ä"), "%C3%A4");
    }

    /// The `fetchModels ok` exchange: `models/embedding-001` is dropped because it
    /// does not start with `models/gemini`.
    #[tokio::test]
    async fn fetch_models_filters_to_gemini_names() {
        let transport = StubTransport::new(HttpResponse::json(
            StatusCode::OK,
            &json!({
                "models": [
                    { "name": "models/gemini-2.5-flash", "displayName": "Gemini 2.5 Flash", "inputTokenLimit": 1_048_576 },
                    { "name": "models/gemini-2.5-pro", "displayName": "Gemini 2.5 Pro", "inputTokenLimit": 1_048_576 },
                    { "name": "models/embedding-001", "displayName": "Embedding 001" }
                ]
            }),
        ));
        let env = EnvOverrides::new();
        let models = GeminiAdapter
            .fetch_models(&context(SECRET), &call(&transport, &env))
            .await
            .expect("fetch");

        let ids: Vec<&str> = models.iter().map(|model| model.id.as_str()).collect();
        assert_eq!(ids, vec!["gemini-2.5-flash", "gemini-2.5-pro"]);
        assert_eq!(models[0].name, "Gemini 2.5 Flash");
        assert_eq!(models[0].provider, "gemini");
        assert_eq!(models[0].context_window, Some(1_048_576.0));

        let seen = transport.seen.lock().expect("lock");
        assert_eq!(seen[0].url, models_url(SECRET));
        assert_eq!(seen[0].method, http::Method::GET);
        assert!(seen[0].headers.is_empty(), "fetchModels sends no headers");
    }

    /// The `fetchModels 401` exchange: a non-ok status yields an empty list, not
    /// an error.
    #[tokio::test]
    async fn fetch_models_returns_nothing_on_a_non_ok_status() {
        let transport = StubTransport::new(HttpResponse::json(
            StatusCode::UNAUTHORIZED,
            &json!({ "error": { "code": 401, "message": "API key not valid.", "status": "UNAUTHENTICATED" } }),
        ));
        let env = EnvOverrides::new();
        let models = GeminiAdapter
            .fetch_models(&context(SECRET), &call(&transport, &env))
            .await
            .expect("fetch does not propagate a status error");
        assert!(models.is_empty());
    }

    /// `contents: 'Ping'` is normalised by the SDK; the `testConnectivity ping`
    /// exchange records the normalised shape.
    #[test]
    fn build_ping_body_matches_the_sdk_normalisation() {
        assert_eq!(
            build_ping_body(),
            json!({ "contents": [{ "parts": [{ "text": "Ping" }], "role": "user" }] })
        );
    }

    /// The `dispatchGateway text` exchange. The recorder drives
    /// `messages: [system('You are a test.'), user('Say pong')]` with
    /// `max_tokens: 64` and `temperature: 0.5`.
    #[test]
    fn build_gateway_body_matches_the_text_exchange() {
        let mut request = GatewayRequest::new(
            "gemini-2.5-flash",
            vec![
                GatewayMessage::new(GatewayRole::System, "You are a test."),
                GatewayMessage::user("Say pong"),
            ],
        );
        request.temperature = Some(0.5);
        request.max_tokens = Some(64);

        assert_eq!(
            build_gateway_body(&request),
            json!({
                "contents": [{ "parts": [{ "text": "Say pong" }], "role": "user" }],
                "systemInstruction": { "parts": [{ "text": "You are a test." }], "role": "user" },
                "generationConfig": { "temperature": 0.5, "maxOutputTokens": 64 }
            })
        );
    }

    /// The `dispatchGateway function call` exchange: the OpenAI-style tool is
    /// rewritten and `generationConfig` is emitted empty.
    #[test]
    fn build_gateway_body_matches_the_function_call_exchange() {
        let mut request = GatewayRequest::new(
            "gemini-2.5-flash",
            vec![GatewayMessage::user("Wetter in Berlin?")],
        );
        request.tools = Some(vec![json!({
            "type": "function",
            "function": {
                "name": "get_weather",
                "description": "Current weather for a city",
                "parameters": {
                    "type": "object",
                    "properties": { "city": { "type": "string", "description": "City name" } },
                    "required": ["city"]
                }
            }
        })]);

        assert_eq!(
            build_gateway_body(&request),
            json!({
                "contents": [{ "parts": [{ "text": "Wetter in Berlin?" }], "role": "user" }],
                "tools": [{
                    "functionDeclarations": [{
                        "name": "get_weather",
                        "description": "Current weather for a city",
                        "parameters": {
                            "type": "OBJECT",
                            "properties": { "city": { "type": "STRING", "description": "City name" } },
                            "required": ["city"]
                        }
                    }]
                }],
                "generationConfig": {}
            })
        );
    }

    /// A tool that already carries `functionDeclarations` is passed through
    /// unchanged; a tool without a `function` object or without a name is dropped.
    #[test]
    fn normalize_gemini_tools_keeps_an_existing_declaration() {
        let already_normalized = json!({ "functionDeclarations": [{ "name": "x" }] });
        let normalized = normalize_gemini_tools(&[
            already_normalized.clone(),
            json!({ "type": "function" }),
            json!({ "type": "function", "function": { "description": "nameless" } }),
            json!("not-an-object"),
        ]);
        assert_eq!(normalized, vec![already_normalized]);
    }

    /// A truthy `functionCalls` array wins over the candidate parts.
    #[test]
    fn extract_gemini_function_calls_prefers_the_top_level_array() {
        let result = json!({
            "functionCalls": [{ "name": "top" }],
            "candidates": [{ "content": { "parts": [{ "functionCall": { "name": "nested" } }] } }]
        });
        let calls = extract_gemini_function_calls(&result);
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name, "top");
    }

    /// A part whose `functionCall` has no name is dropped, and absent usage
    /// metadata yields `None` rather than a zeroed usage.
    #[test]
    fn function_calls_without_a_name_are_dropped() {
        let result = json!({
            "candidates": [{ "content": { "parts": [
                { "functionCall": { "name": "kept", "args": { "a": 1 } } },
                { "functionCall": { "args": {} } }
            ] } }]
        });
        let calls = extract_gemini_function_calls(&result);
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name, "kept");
        assert_eq!(calls[0].args, Some(json!({ "a": 1 })));
        assert_eq!(extract_gemini_usage(&result), None);
    }

    /// A present `usageMetadata` defaults the counts the API omitted to zero.
    #[test]
    fn extract_gemini_usage_defaults_missing_counts_to_zero() {
        assert_eq!(
            extract_gemini_usage(&json!({ "usageMetadata": { "totalTokenCount": 7 } })),
            Some(GatewayUsage {
                prompt_tokens: 0,
                completion_tokens: 0,
                total_tokens: 7,
            })
        );
    }

    /// The `dispatchGateway text` response: text plus usage, no function calls.
    #[tokio::test]
    async fn dispatch_gateway_parses_text_and_usage() {
        let transport = StubTransport::new(HttpResponse::json(
            StatusCode::OK,
            &json!({
                "candidates": [{
                    "content": { "parts": [{ "text": "pong" }], "role": "model" },
                    "finishReason": "STOP"
                }],
                "usageMetadata": { "promptTokenCount": 3, "candidatesTokenCount": 1, "totalTokenCount": 4 },
                "modelVersion": "gemini-2.5-flash"
            }),
        ));
        let env = EnvOverrides::new();
        let response = GeminiAdapter
            .dispatch_gateway(
                &context(SECRET),
                &call(&transport, &env),
                &gateway_request(),
                &DispatchOptions::default(),
            )
            .await
            .expect("gemini never returns Err");

        assert!(response.ok);
        assert_eq!(response.text, "pong");
        assert_eq!(response.model, "gemini-2.5-flash");
        assert_eq!(response.provider, "gemini");
        assert_eq!(
            response.usage,
            Some(GatewayUsage {
                prompt_tokens: 3,
                completion_tokens: 1,
                total_tokens: 4,
            })
        );
        assert!(response.function_calls.is_none());
    }

    /// The `dispatchGateway function call` response: the call is lifted out of
    /// the parts and the text stays empty.
    #[tokio::test]
    async fn dispatch_gateway_returns_the_function_call() {
        let transport = StubTransport::new(HttpResponse::json(
            StatusCode::OK,
            &json!({
                "candidates": [{
                    "content": {
                        "parts": [{ "functionCall": { "name": "get_weather", "args": { "city": "Berlin" } } }],
                        "role": "model"
                    },
                    "finishReason": "STOP"
                }],
                "usageMetadata": { "promptTokenCount": 9, "candidatesTokenCount": 5, "totalTokenCount": 14 }
            }),
        ));
        let env = EnvOverrides::new();
        let response = GeminiAdapter
            .dispatch_gateway(
                &context(SECRET),
                &call(&transport, &env),
                &gateway_request(),
                &DispatchOptions::default(),
            )
            .await
            .expect("dispatch");

        assert!(response.ok);
        assert_eq!(response.text, "");
        let calls = response.function_calls.expect("function calls");
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name, "get_weather");
        assert_eq!(calls[0].args, Some(json!({ "city": "Berlin" })));
    }

    /// The `x-goog-api-key` and `content-type` headers of the recorded POST
    /// exchanges, and the `:generateContent` URL.
    #[tokio::test]
    async fn dispatch_gateway_sends_the_recorded_headers() {
        let transport = StubTransport::new(HttpResponse::json(
            StatusCode::OK,
            &json!({ "candidates": [{ "content": { "parts": [{ "text": "pong" }] } }] }),
        ));
        let env = EnvOverrides::new();
        GeminiAdapter
            .dispatch_gateway(
                &context(SECRET),
                &call(&transport, &env),
                &gateway_request(),
                &DispatchOptions::default(),
            )
            .await
            .expect("dispatch");

        let seen = transport.seen.lock().expect("lock");
        assert_eq!(seen[0].url, generate_content_url("gemini-2.5-flash"));
        assert_eq!(seen[0].method, http::Method::POST);
        assert_eq!(
            seen[0].headers.get("content-type").expect("ctype"),
            "application/json"
        );
        assert_eq!(seen[0].headers.get("x-goog-api-key").expect("key"), SECRET);
    }

    /// `try { … } catch { }`: a transport failure becomes a failed response, never
    /// an `Err` (see the module header).
    #[tokio::test]
    async fn dispatch_gateway_reports_a_transport_failure_as_a_failed_response() {
        let env = EnvOverrides::new();
        let call = ProviderCall {
            transport: &UnreachableTransport,
            attachments: &NOOP_ATTACHMENT_STORE,
            env: &env,
        };
        let response = GeminiAdapter
            .dispatch_gateway(
                &context(SECRET),
                &call,
                &gateway_request(),
                &DispatchOptions::default(),
            )
            .await
            .expect("gemini swallows the transport error");

        assert!(!response.ok);
        assert_eq!(
            response.error.as_deref(),
            Some("No HTTP transport is configured.")
        );
        assert_eq!(response.provider, "gemini");
    }

    /// The `testConnectivity ping` exchange: a text reply verifies and the
    /// catalog default model is used when `options.model` is absent.
    #[tokio::test]
    async fn test_connectivity_verifies_on_a_text_reply() {
        let transport = StubTransport::new(HttpResponse::json(
            StatusCode::OK,
            &json!({
                "candidates": [{ "content": { "parts": [{ "text": "pong" }], "role": "model" }, "finishReason": "STOP" }],
                "usageMetadata": { "promptTokenCount": 3, "candidatesTokenCount": 1, "totalTokenCount": 4 }
            }),
        ));
        let env = EnvOverrides::new();
        let result = GeminiAdapter
            .test_connectivity(&context(SECRET), &call(&transport, &env), None)
            .await;

        assert!(result.ok);
        assert_eq!(result.message, CONNECTIVITY_OK);
        assert_eq!(result.rate_limits, None);
        let seen = transport.seen.lock().expect("lock");
        assert_eq!(seen[0].url, generate_content_url("gemini-2.5-flash"));
        assert_eq!(
            seen[0].body.as_deref(),
            Some(r#"{"contents":[{"parts":[{"text":"Ping"}],"role":"user"}]}"#)
        );
    }

    /// A 2xx response without usable text is a failed connectivity check.
    #[tokio::test]
    async fn test_connectivity_reports_missing_content() {
        let transport = StubTransport::new(HttpResponse::json(
            StatusCode::OK,
            &json!({ "candidates": [{ "content": { "parts": [{ "text": "   " }] } }] }),
        ));
        let env = EnvOverrides::new();
        let result = GeminiAdapter
            .test_connectivity(&context(SECRET), &call(&transport, &env), None)
            .await;

        assert!(!result.ok);
        assert_eq!(result.message, CONNECTIVITY_NO_CONTENT);
    }

    /// A non-ok status reports the API message, and an explicit `options.model`
    /// overrides the catalog default.
    #[tokio::test]
    async fn test_connectivity_reports_a_non_ok_status() {
        let transport = StubTransport::new(HttpResponse::json(
            StatusCode::UNAUTHORIZED,
            &json!({ "error": { "code": 401, "message": "API key not valid. Please pass a valid API key.", "status": "UNAUTHENTICATED" } }),
        ));
        let env = EnvOverrides::new();
        let result = GeminiAdapter
            .test_connectivity(
                &context(SECRET),
                &call(&transport, &env),
                Some("gemini-2.5-pro"),
            )
            .await;

        assert!(!result.ok);
        assert_eq!(
            result.message,
            "API key not valid. Please pass a valid API key."
        );
        let seen = transport.seen.lock().expect("lock");
        assert_eq!(seen[0].url, generate_content_url("gemini-2.5-pro"));
    }
}
