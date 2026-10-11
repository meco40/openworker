//! Port of the embedding dispatch of slice S4 (Model Hub): the router of
//! `service/dispatch/embedding.ts` plus the three provider adapters of
//! `service/embedding/`.
//!
//! | Rust | TypeScript |
//! | --- | --- |
//! | [`dispatch_embedding`] | `service/dispatch/embedding.ts:11-81` |
//! | [`dispatch_gemini_embedding`] | `service/embedding/gemini.ts:11-57` |
//! | [`normalize_openai_compatible_embedding_input`] | `service/embedding/openaiCompatible.ts:10-58` |
//! | [`dispatch_openai_compatible_embedding`] | `service/embedding/openaiCompatible.ts:60-112` |
//! | [`dispatch_cohere_embedding`] | `service/embedding/cohere.ts:6-53` |
//! | [`GeminiEmbeddingInput`] | `service/embedding/gemini.ts:6-9` |
//! | [`NormalizedEmbeddingInput`] | `service/embedding/openaiCompatible.ts:14` |
//! | the named exports | `service/embedding/index.ts:1-6` |
//!
//! The shared helpers are *not* re-implemented here: [`as_positive_integer`],
//! [`extract_text_parts`], [`try_extract_batch_payload_as_embed_content`] and
//! [`preferred_embedding_entry`] come from [`super::utils`] (the port of
//! `service/utils.ts`), `normalizeBearerSecret` comes from
//! [`crate::model_hub::openai_compatible::utils::normalize_bearer_secret`], and
//! `parseErrorMessage` / `fetchWithTimeout` come from [`crate::model_hub::http`].
//!
//! # The Gemini adapter: SDK → REST
//!
//! `service/embedding/gemini.ts` builds its request with `@google/genai`
//! (`new GoogleGenAI({ apiKey }).models.embedContent(payload)`). There is no Rust
//! SDK in this workspace and `betaclaw-core` owns no HTTP client, so the port
//! speaks the REST surface the SDK compiles down to, exactly as
//! [`crate::model_hub::providers::gemini`] does for `generateContent`. The
//! mapping below was read out of the pinned bundle
//! (`node_modules/@google/genai/dist/index.mjs`, version `1.42.0`):
//!
//! | TypeScript (`@google/genai@1.42.0`) | REST |
//! | --- | --- |
//! | `new GoogleGenAI({ apiKey: secret })` | `x-goog-api-key: <secret>` |
//! | `ai.models.embedContent(params)` | `POST {API_BASE_URL}/models/{tModel(model)}:batchEmbedContents` (`dist/index.mjs:16739-16740`) |
//! | body of `embedContent` | `{ requests: [{ content, taskType?, title?, outputDimensionality?, model }] }` (`embedContentParametersPrivateToMldev`, `dist/index.mjs:12284-12313`) |
//! | `contents` entries | one `requests[]` entry per element; a string becomes `{ role: 'user', parts: [{ text }] }` (`tContentsForEmbed`/`tContent`/`tParts`, `dist/index.mjs:2651-2718`) |
//! | `ai.models.batchEmbedContents(params)` | **absent** from the `Models` class in the pinned bundle, so `typeof modelsApi.batchEmbedContents !== 'function'` is a constant `false` and the fallback of `gemini.ts:42-47` is the live branch |
//! | `{API_BASE_URL}/models/{model}:embedContent` | deliberately **not** used: the MLDev generator behind `embedContent` always serialises to `:batchEmbedContents`, even for a single content, and `:embedContent` answers with a different body shape (`{ embedding: { values } }` instead of `{ embeddings: [{ values }] }`) than the one `dispatchGeminiEmbedding` hands back verbatim |
//!
//! Every message the port can produce for a payload the SDK rejects
//! (`model is required and must be a string`, `invalid model parameter`,
//! `Key 'model' not found in valueMap.`,
//! `Value must be a list given an array path requests[]`,
//! `mimeType parameter is not supported in Gemini API.`, …) is the message the
//! SDK throws, which `gemini.ts:53-56` turns into `{ error: message }`. The port
//! therefore reproduces the SDK's `Key`-template and `setValueByPath` semantics
//! instead of inventing a Rust-flavoured error for the same situation.
//!
//! # Request mapping of the two REST adapters
//!
//! | Rust | TypeScript |
//! | --- | --- |
//! | POST `https://api.cohere.com/v2/embed` | `cohere.ts:18-32` |
//! | headers `Authorization: Bearer …`, `Content-Type: application/json` | `cohere.ts:21-24` |
//! | body `{ model, texts, embedding_types: ['float'] }` | `cohere.ts:25-29` |
//! | POST `{baseUrl}/embeddings` (one trailing `/` stripped) | `openaiCompatible.ts:86-97` |
//! | headers `Content-Type`, optional `Authorization`, openrouter's `HTTP-Referer`/`X-Title` | `openaiCompatible.ts:73-83` |
//! | body `{ model, input, dimensions? }` | `openaiCompatible.ts:90-94` |
//! | both: timeout `60_000` | `cohere.ts:31`, `openaiCompatible.ts:96` |

//!
//! # Divergences from the TypeScript
//!
//! - **Result type.** The TypeScript returns a plain `Record<string, unknown>` and
//!   lets a decryption or transport failure escape as a rejected promise. The
//!   port returns `Result<Value, ServiceError>`: `Ok` carries the same record
//!   (including every `{ error: … }` shape) and `Err` carries exactly the two
//!   failures that escape in TypeScript — `decryptSecret` (`gemini.ts:17`,
//!   `dispatch/embedding.ts:42/55`) and a failing `fetchWithTimeout`
//!   (`cohere.ts:17`, `openaiCompatible.ts:85`). The Gemini adapter catches its
//!   own transport failure, because the SDK call sits inside its `try`
//!   (`gemini.ts:31-56`), so [`dispatch_gemini_embedding`] returns `Err` only for
//!   a secret that cannot be decrypted.
//! - **Transport.** `fetch` is not available in this crate, so every function
//!   takes the transport explicitly — the routers take it from
//!   [`ServiceDependencies`]. The TypeScript parameter lists are unchanged apart
//!   from that addition, so the named exports of `embedding/index.ts` stay
//!   wireable one for one.
//! - **Deadline of the Gemini call.** The SDK issues the request without a
//!   deadline unless `config.httpOptions.timeout` is set
//!   (`dist/index.mjs:7205-7215`), which the app never does. [`HttpRequest`]
//!   always carries a `timeout_ms`, so the port leaves the crate default
//!   ([`DEFAULT_REQUEST_TIMEOUT_MS`]) in place — the same choice the Gemini chat
//!   adapter makes. A payload-supplied `config.httpOptions` is therefore ignored.
//! - **Gemini response wrapper.** The SDK returns an `EmbedContentResponse`
//!   instance carrying `sdkHttpResponse.headers` (a WHATWG `Headers`, which
//!   JSON-serialises to `{}`) next to the `embeddings` and `metadata` copied by
//!   `embedContentResponseFromMldev` (`dist/index.mjs:12356-12378`). The port
//!   returns the parsed REST body verbatim, which holds exactly those
//!   `embeddings`/`metadata` keys and drops the non-caller-visible wrapper. Both
//!   `result ?? {}` cases are kept (`gemini.ts:38/47/50`): a body that cannot be
//!   parsed reports the failure `response.json()` would throw, a parsed
//!   non-object reads as `{}`.
//! - **Non-JSON error body of a failed Gemini call.** `throwErrorIfNotOK`
//!   (`dist/index.mjs:7512-7536`) reports `JSON.stringify(errorBody)`, where
//!   `errorBody` is the parsed JSON body or, for a non-JSON response,
//!   `{"error":{"message":<text>,"code":<status>,"status":<statusText>}}`. The
//!   port re-serialises the parsed body for the JSON case — `serde_json` is built
//!   with `preserve_order`, so the key order of the server's document survives —
//!   and builds the same synthesised object for the non-JSON case. Only the text
//!   of a JSON *parse* failure differs from V8's `SyntaxError` wording.
//! - **`data`/`embeddings` that are not arrays.** `(json.data ?? []).map(…)`
//!   (`openaiCompatible.ts:104-106`) and the `Array.isArray` reads of
//!   `cohere.ts:39-43` throw a `TypeError` when the field exists with a
//!   non-array value. That `TypeError` has no counterpart behind the transport
//!   seam, so the port reads a non-array as "no data" and reports an empty vector
//!   list.
//! - **Bearer normalisation.** [`normalize_bearer_secret`] is the port of
//!   `normalizeBearerSecret` (`utils.ts:11-16`) and is shared with the
//!   OpenAI-compatible chat layer, so this path inherits its extra quote and
//!   backslash trimming. Only the *unnormalised* secret is compared against the
//!   empty-secret errors of `dispatch/embedding.ts:43/57`, exactly as in
//!   TypeScript.
//! - **Batch extraction trims.** [`try_extract_batch_payload_as_embed_content`]
//!   pushes trimmed texts where `utils.ts:68/76/84` pushes the raw string. The
//!   difference is observable only for padded text and is inherited from the
//!   already-ported [`super::utils`], not introduced here.
//! - **`{ ...input.payload, model }`** (`gemini.ts:28`) spreads a non-object
//!   payload like `{}`; a *string* payload would spread by index in JavaScript.
//!   `payload` is declared `Record<string, unknown>` in both languages, so the
//!   port treats anything that is not a JSON object as the empty object.

use serde_json::{json, Map, Value};

use crate::model_hub::crypto::decrypt_secret;
use crate::model_hub::env::EnvOverrides;
use crate::model_hub::http::{
    fetch_with_timeout, parse_error_message, HttpRequest, HttpResponse, HttpTransport,
    DEFAULT_REQUEST_TIMEOUT_MS,
};
use crate::model_hub::openai_compatible::utils::normalize_bearer_secret;
use crate::model_hub::provider_catalog::find_provider;
use crate::model_hub::providers::gemini::API_BASE_URL as GEMINI_API_BASE_URL;
use crate::model_hub::repository::ModelHubRepository;
use crate::model_hub::types::{ProviderAccountRecord, ProviderAuthMethod, ProviderCatalogEntry};

use super::types::{EmbeddingInput, EmbeddingOperation, EMBEDDING_PROFILE_ID};
use super::utils::{
    as_positive_integer, extract_text_parts, preferred_embedding_entry,
    try_extract_batch_payload_as_embed_content,
};
use super::{ServiceDependencies, ServiceError};

/// `'https://api.cohere.com/v2/embed'` from `cohere.ts:18`.
pub const COHERE_EMBED_URL: &str = "https://api.cohere.com/v2/embed";

/// The `60_000` of `cohere.ts:31` and `openaiCompatible.ts:96`.
pub const EMBEDDING_REQUEST_TIMEOUT_MS: u64 = 60_000;

/// `'http://localhost:11434'` — the fallback of
/// `process.env.OLLAMA_BASE_URL || 'http://localhost:11434'`
/// (`dispatch/embedding.ts:65`).
pub const DEFAULT_OLLAMA_BASE_URL: &str = "http://localhost:11434";

/// `'Embedding payload is missing a supported model/input format.'`
/// (`cohere.ts:14`, `openaiCompatible.ts:70`).
pub const MISSING_MODEL_OR_INPUT_ERROR: &str =
    "Embedding payload is missing a supported model/input format.";

/// `GeminiEmbeddingInput` from `service/embedding/gemini.ts:6-9`.
///
/// The TypeScript declares a second interface whose shape is identical to
/// [`EmbeddingInput`] (`service/types.ts:43-46`). The port collapses the
/// duplicate into the shared type so [`dispatch_embedding`] can hand its `input`
/// straight through, exactly like `dispatch/embedding.ts:80` does.
pub type GeminiEmbeddingInput = EmbeddingInput;

/// `normalizeOpenAICompatibleEmbeddingInput`'s return value
/// (`openaiCompatible.ts:14`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NormalizedEmbeddingInput {
    /// `model` — the requested model, or the caller's fallback, trimmed.
    pub model: String,
    /// `input` — the texts, already trimmed and without empty entries.
    pub input: Vec<String>,
    /// `dimensions` — `asPositiveInteger(payload.dimensions)`.
    pub dimensions: Option<u64>,
}

/// `tModel(apiClient, model)` for the Gemini API (`dist/index.mjs:2563-2589`).
///
/// Returns the `models/`-prefixed resource path the MLDev generators use both in
/// the URL template and in `requests[].model`. The TypeScript reads the model off
/// a `Record<string, unknown>`, so `!model || typeof model !== 'string'` reports
/// a missing, empty and non-string value with the same message.
fn gemini_model_path(model: &Value) -> Result<String, String> {
    let Some(text) = model.as_str().filter(|text| !text.is_empty()) else {
        return Err("model is required and must be a string".to_string());
    };
    if text.contains("..") || text.contains('?') || text.contains('&') {
        return Err("invalid model parameter".to_string());
    }
    if text.starts_with("models/") || text.starts_with("tunedModels/") {
        return Ok(text.to_string());
    }
    Ok(format!("models/{text}"))
}

/// JavaScript truthiness of a JSON value, as `tContentsForEmbed`'s
/// `if (!origin)` and `setValueByPath`'s `if (!value)` use it. An empty array and
/// an empty object are **truthy** in JavaScript and stay usable here.
fn is_js_falsy(value: &Value) -> bool {
    value.is_null()
        || matches!(value, Value::Bool(false))
        || value.as_str() == Some("")
        || value.as_f64() == Some(0.0)
}

/// `tPart` from `dist/index.mjs:2640-2650`.
fn gemini_part(origin: &Value) -> Result<Value, String> {
    if origin.is_null() {
        return Err("PartUnion is required".to_string());
    }
    match origin {
        Value::Object(_) => Ok(origin.clone()),
        Value::String(text) => Ok(json!({ "text": text })),
        // The JavaScript template literal interpolates `typeof origin`, so a
        // number and a boolean are the only rejected JSON scalars.
        Value::Number(_) => Err("Unsupported part type: number".to_string()),
        Value::Bool(_) => Err("Unsupported part type: boolean".to_string()),
        // `typeof [] === 'object'`, so an array is a valid Part and passes
        // through unchanged, exactly like an object does.
        Value::Array(_) => Ok(origin.clone()),
        Value::Null => Err("PartUnion is required".to_string()),
    }
}

/// `tParts` from `dist/index.mjs:2651-2660`.
fn gemini_parts(origin: &Value) -> Result<Vec<Value>, String> {
    match origin.as_array() {
        Some(entries) if entries.is_empty() => Err("PartListUnion is required".to_string()),
        Some(entries) => entries.iter().map(gemini_part).collect(),
        None => Ok(vec![gemini_part(origin)?]),
    }
}

/// `tContent` from `dist/index.mjs:2681-2694`.
///
/// `_isContent` (`dist/index.mjs:2662-2669`) is `'parts' in origin &&
/// Array.isArray(origin.parts)`, so an object that already carries a `parts`
/// array is passed through unchanged and everything else is wrapped in a
/// user-role `Content`.
fn gemini_content(origin: &Value) -> Result<Value, String> {
    if origin.is_null() {
        return Err("ContentUnion is required".to_string());
    }
    if origin.get("parts").and_then(Value::as_array).is_some() {
        return Ok(origin.clone());
    }
    Ok(json!({ "role": "user", "parts": gemini_parts(origin)? }))
}

/// `tContentsForEmbed` from `dist/index.mjs:2695-2718`, Gemini API branch.
///
/// A falsy `contents` yields no entries, which still creates the `requests` key
/// (see [`assign_gemini_requests_field`]).
fn gemini_contents_for_embed(contents: &Value) -> Result<Vec<Value>, String> {
    if is_js_falsy(contents) {
        return Ok(Vec::new());
    }
    match contents.as_array() {
        Some(entries) => entries.iter().map(gemini_content).collect(),
        None => Ok(vec![gemini_content(contents)?]),
    }
}

/// `setValueByPath(body, ['requests[]', key], value)` for the Gemini body
/// (`dist/index.mjs:56-84`).
///
/// The `requests[]` path means "one entry per element of `value`" when `requests`
/// does not exist yet: an array value creates that many empty entries, anything
/// else throws — which is why a payload with a `model` but without `contents`
/// fails with `Value must be a list given an array path requests[]`. The
/// `Object.assign` merge tail of `setValueByPath` (`dist/index.mjs:98-118`) is
/// unreachable on these paths: every key is written once, into a freshly created
/// entry.
fn assign_gemini_requests_field(
    body: &mut Map<String, Value>,
    key: &str,
    value: &Value,
) -> Result<(), String> {
    if !body.contains_key("requests") {
        let Some(entries) = value.as_array() else {
            return Err("Value must be a list given an array path requests[]".to_string());
        };
        body.insert(
            "requests".to_string(),
            Value::Array(entries.iter().map(|_| json!({})).collect()),
        );
    }
    let Some(entries) = body.get_mut("requests").and_then(Value::as_array_mut) else {
        return Ok(());
    };
    for (index, entry) in entries.iter_mut().enumerate() {
        // `Array.isArray(value)` assigns `value[j]` per entry — `undefined` for a
        // shorter array, which the SDK's writer drops again.
        let item = match value.as_array() {
            Some(values) => values.get(index),
            None => Some(value),
        };
        let Some(item) = item else {
            continue;
        };
        if let Some(fields) = entry.as_object_mut() {
            fields.insert(key.to_string(), item.clone());
        }
    }
    Ok(())
}

/// The `embedContent` request of the MLDev SDK path: `_url.model` +
/// `embedContentParametersPrivateToMldev` + `embedContentInternal`
/// (`dist/index.mjs:12284-12313`, `16737-16740`).
///
/// Every `Err` is an SDK exception, i.e. what `gemini.ts:53-56` reports as
/// `{ error: message }`.
fn gemini_embed_content_request(payload: &Value, secret: &str) -> Result<HttpRequest, String> {
    // `_url.model` — only set when `model != null`.
    let url_model = match payload.get("model") {
        Some(model) if !model.is_null() => Some(gemini_model_path(model)?),
        _ => None,
    };

    let mut body = Map::new();

    // `contents` → `requests[].content`.
    if let Some(contents) = payload.get("contents").filter(|value| !value.is_null()) {
        let entries = Value::Array(gemini_contents_for_embed(contents)?);
        assign_gemini_requests_field(&mut body, "content", &entries)?;
    }

    // `content` (singular) is transformed and the result is *discarded* by the
    // SDK (`dist/index.mjs:12300-12303`), so only its validation is observable.
    if let Some(content) = payload.get("content").filter(|value| !value.is_null()) {
        gemini_content(content)?;
    }

    // `config` → `requests[]` fields, in source order.
    if let Some(config) = payload.get("config").filter(|value| !value.is_null()) {
        for key in ["taskType", "title", "outputDimensionality"] {
            if let Some(value) = config.get(key).filter(|value| !value.is_null()) {
                assign_gemini_requests_field(&mut body, key, value)?;
            }
        }
        if config.get("mimeType").is_some() {
            return Err("mimeType parameter is not supported in Gemini API.".to_string());
        }
        if config.get("autoTruncate").is_some() {
            return Err("autoTruncate parameter is not supported in Gemini API.".to_string());
        }
    }

    // `requests[].model` — guarded by `!== undefined`, so an explicit `null`
    // reaches `tModel` and fails there.
    if let Some(model) = payload.get("model") {
        let path = gemini_model_path(model)?;
        assign_gemini_requests_field(&mut body, "model", &Value::String(path))?;
    }

    // `formatMap('{model}:batchEmbedContents', body['_url'])`.
    let model = url_model.ok_or_else(|| "Key 'model' not found in valueMap.".to_string())?;

    Ok(
        HttpRequest::post(format!("{GEMINI_API_BASE_URL}/{model}:batchEmbedContents"))
            .header("content-type", "application/json")
            .header("x-goog-api-key", secret)
            .json_body(&Value::Object(body))
            .timeout_ms(DEFAULT_REQUEST_TIMEOUT_MS),
    )
}

/// `throwErrorIfNotOK` from `dist/index.mjs:7512-7536`.
///
/// A JSON content type reports `JSON.stringify(await response.json())`; for a
/// body that is itself unparsable, `response.json()` rejects and that rejection
/// wins, which the port mirrors with the parse error.
fn gemini_api_error_message(response: &HttpResponse) -> String {
    if response.has_json_content_type() {
        return match serde_json::from_str::<Value>(&response.body) {
            Ok(body) => serde_json::to_string(&body).unwrap_or_default(),
            Err(error) => error.to_string(),
        };
    }
    json!({
        "error": {
            "message": response.body,
            "code": response.status.as_u16(),
            "status": response.status_text,
        }
    })
    .to_string()
}

/// The inside of the `try { … } catch { … }` of `gemini.ts:31-51` around one SDK
/// call: `result ?? {}` on success and `{ error: message }` on any failure.
async fn gemini_embed_content_call(request: HttpRequest, transport: &dyn HttpTransport) -> Value {
    match fetch_with_timeout(transport, request).await {
        // The SDK rejects with the client error (`TypeError`/`ApiError`); the port
        // reports the transport's own message.
        Err(error) => json!({ "error": error.to_string() }),
        Ok(response) if !response.is_ok() => {
            json!({ "error": gemini_api_error_message(&response) })
        }
        Ok(response) => match serde_json::from_str::<Value>(&response.body) {
            Ok(Value::Object(body)) => Value::Object(body),
            // `Object.assign(new EmbedContentResponse(), resp)` always yields an
            // object; a non-object body has no counterpart and reads as `{}`.
            Ok(_) => json!({}),
            Err(error) => json!({ "error": error.to_string() }),
        },
    }
}

/// `dispatchGeminiEmbedding` from `gemini.ts:11-57`.
///
/// `defaultEmbeddingModel` is substituted only for `embedContent`
/// (`gemini.ts:26-29`); the batch operation is the one of the two branches of
/// `gemini.ts:40-51` whose SDK method exists in the pinned bundle (see the module
/// header), so the payload is folded through
/// [`try_extract_batch_payload_as_embed_content`] and an inextricable payload
/// answers `{ embeddings: [] }`.
pub async fn dispatch_gemini_embedding(
    record: &ProviderAccountRecord,
    encryption_key: &str,
    input: &GeminiEmbeddingInput,
    default_embedding_model: Option<&str>,
    transport: &dyn HttpTransport,
) -> Result<Value, ServiceError> {
    // `decryptSecret` sits in front of the `try` (`gemini.ts:17`), so its failure
    // escapes instead of becoming `{ error }`.
    let secret = decrypt_secret(&record.encrypted_secret_payload(), encryption_key)?;
    if secret.trim().is_empty() {
        return Ok(json!({ "error": "Gemini account secret is missing or empty." }));
    }

    // `typeof input.payload.model === 'string' && input.payload.model.trim().length > 0`.
    let requested_model = input
        .payload
        .get("model")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|model| !model.is_empty())
        .map(str::to_string);

    let embedding_payload = match (input.operation.as_str(), &requested_model) {
        ("embedContent", None) => match default_embedding_model {
            Some(default_model) => {
                let mut fields = match input.payload.clone() {
                    Value::Object(fields) => fields,
                    _ => Map::new(),
                };
                fields.insert(
                    "model".to_string(),
                    Value::String(default_model.to_string()),
                );
                Value::Object(fields)
            }
            None => input.payload.clone(),
        },
        _ => input.payload.clone(),
    };

    match input.operation {
        EmbeddingOperation::EmbedContent => {
            let request = gemini_embed_content_request(&embedding_payload, &secret);
            match request {
                Ok(request) => Ok(gemini_embed_content_call(request, transport).await),
                Err(message) => Ok(json!({ "error": message })),
            }
        }
        EmbeddingOperation::BatchEmbedContents => {
            // `typeof modelsApi.batchEmbedContents !== 'function'` (`gemini.ts:41`)
            // is a constant `false` for the pinned SDK, so this is the live branch.
            match try_extract_batch_payload_as_embed_content(&input.payload) {
                None => Ok(json!({ "embeddings": [] })),
                Some(fallback) => {
                    match gemini_embed_content_request(&fallback.to_payload(), &secret) {
                        Ok(request) => Ok(gemini_embed_content_call(request, transport).await),
                        Err(message) => Ok(json!({ "error": message })),
                    }
                }
            }
        }
        // The TypeScript template literal echoes the operation value back.
        EmbeddingOperation::Other(_) => Ok(json!({
            "error": format!("Unknown embedding operation: {}", input.operation.as_str())
        })),
    }
}

/// `normalizeOpenAICompatibleEmbeddingInput` from `openaiCompatible.ts:10-58`.
///
/// The precedence is exactly the source's: the requested/fallback model, then
/// `input` (string or array), then — for `embedContent` only — the Gemini-shaped
/// `contents`/`content`, and for every other operation the batch extraction of
/// `requests` before a final `contents` look. `null` is the TypeScript's `null`
/// and is reported as `None` here.
pub fn normalize_openai_compatible_embedding_input(
    operation: &EmbeddingOperation,
    payload: &Value,
    fallback_model: &str,
) -> Option<NormalizedEmbeddingInput> {
    let requested_model = payload
        .get("model")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|model| !model.is_empty())
        .unwrap_or("")
        .to_string();
    // `requestedModel || fallbackModel.trim()`.
    let model = if requested_model.is_empty() {
        fallback_model.trim().to_string()
    } else {
        requested_model.clone()
    };
    if model.is_empty() {
        return None;
    }
    let dimensions = as_positive_integer(payload.get("dimensions"));

    // `payload.input !== undefined` — a JSON `null` counts as present and falls
    // through to the shape branches below, exactly like the TypeScript checks do.
    if let Some(input) = payload.get("input") {
        if let Some(text) = input.as_str() {
            if !text.trim().is_empty() {
                return Some(NormalizedEmbeddingInput {
                    model,
                    input: vec![text.trim().to_string()],
                    dimensions,
                });
            }
        }
        if let Some(entries) = input.as_array() {
            let normalized: Vec<String> = entries
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .map(str::to_string)
                .collect();
            if !normalized.is_empty() {
                return Some(NormalizedEmbeddingInput {
                    model,
                    input: normalized,
                    dimensions,
                });
            }
        }
    }

    if matches!(operation, EmbeddingOperation::EmbedContent) {
        let from_contents = texts_of(payload, "contents");
        if !from_contents.is_empty() {
            return Some(NormalizedEmbeddingInput {
                model,
                input: from_contents,
                dimensions,
            });
        }
        let from_content = texts_of(payload, "content");
        if !from_content.is_empty() {
            return Some(NormalizedEmbeddingInput {
                model,
                input: from_content,
                dimensions,
            });
        }
        return None;
    }

    if let Some(batch) = try_extract_batch_payload_as_embed_content(payload) {
        // `requestedModel || batchFallback.model || model` — the middle term can
        // never be empty, so the last one is unreachable.
        return Some(NormalizedEmbeddingInput {
            model: if requested_model.is_empty() {
                batch.model
            } else {
                requested_model
            },
            input: batch.contents,
            dimensions,
        });
    }

    let from_contents = texts_of(payload, "contents");
    if !from_contents.is_empty() {
        return Some(NormalizedEmbeddingInput {
            model,
            input: from_contents,
            dimensions,
        });
    }
    None
}

/// `extractTextParts(payload[key])` for an absent key: `undefined` and `null`
/// both contribute nothing (`utils.ts:18-23`).
fn texts_of(payload: &Value, key: &str) -> Vec<String> {
    extract_text_parts(payload.get(key).unwrap_or(&Value::Null))
}

/// `value.replace(/\/$/, '')` — the pattern has no `g` flag, so only **one**
/// trailing slash is removed (`openaiCompatible.ts:86`,
/// `dispatch/embedding.ts:65`).
fn strip_one_trailing_slash(value: &str) -> &str {
    value.strip_suffix('/').unwrap_or(value)
}

/// The `{ embeddings: [{ values }] }` / `{ embedding: { values } }` answer of
/// `cohere.ts:49-52` and `openaiCompatible.ts:108-111`.
///
/// Every operation other than `embedContent` — including an unknown one — reads
/// as the batch shape.
fn embedding_response(operation: &EmbeddingOperation, vectors: Vec<Value>) -> Value {
    if matches!(operation, EmbeddingOperation::EmbedContent) {
        let values = vectors.into_iter().next().unwrap_or_else(|| json!([]));
        return json!({ "embedding": { "values": values } });
    }
    json!({
        "embeddings": vectors
            .into_iter()
            .map(|values| json!({ "values": values }))
            .collect::<Vec<Value>>()
    })
}

/// `(json.data ?? []).map(…)` of `openaiCompatible.ts:104-106`: only array
/// entries whose `embedding` is a non-empty array survive.
fn openai_compatible_vectors(payload: &Value) -> Vec<Value> {
    payload
        .get("data")
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| entry.get("embedding"))
                .filter_map(non_empty_array)
                .collect()
        })
        .unwrap_or_default()
}

/// `Array.isArray(json.embeddings) ? json.embeddings :
/// Array.isArray(json.embeddings?.float) ? json.embeddings.float : []` from
/// `cohere.ts:39-43`, followed by the non-empty filter of `cohere.ts:45-47`.
fn cohere_vectors(payload: &Value) -> Vec<Value> {
    let raw = match payload.get("embeddings") {
        Some(Value::Array(embeddings)) => embeddings.clone(),
        Some(Value::Object(embeddings)) => embeddings
            .get("float")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
        _ => Vec::new(),
    };
    raw.iter().filter_map(non_empty_array).collect()
}

/// `Array.isArray(embedding) && embedding.length > 0`.
fn non_empty_array(value: &Value) -> Option<Value> {
    match value {
        Value::Array(entries) if !entries.is_empty() => Some(value.clone()),
        _ => None,
    }
}

/// `await response.json().catch(() => ({}))` (`cohere.ts:38`,
/// `openaiCompatible.ts:103`).
///
/// A parsed non-object is kept as-is: reading `.data`/`.embeddings` off it yields
/// nothing in both languages.
fn parse_json_body_or_empty(response: &HttpResponse) -> Value {
    serde_json::from_str::<Value>(&response.body).unwrap_or_else(|_| json!({}))
}

/// `dispatchOpenAICompatibleEmbedding` from `openaiCompatible.ts:60-112`.
///
/// The base URL is the caller's business: `dispatch/embedding.ts:62-73` resolves
/// it (ollama with `OLLAMA_BASE_URL`, lmstudio with `LMSTUDIO_BASE_URL`) and
/// hands the result in as `baseUrl`.
pub async fn dispatch_openai_compatible_embedding(
    provider_id: &str,
    base_url: &str,
    secret: &str,
    operation: &EmbeddingOperation,
    payload: &Value,
    fallback_model: &str,
    transport: &dyn HttpTransport,
) -> Result<Value, ServiceError> {
    let Some(normalized) =
        normalize_openai_compatible_embedding_input(operation, payload, fallback_model)
    else {
        return Ok(json!({ "error": MISSING_MODEL_OR_INPUT_ERROR }));
    };

    let mut request =
        HttpRequest::post(format!("{}/embeddings", strip_one_trailing_slash(base_url)))
            .header("Content-Type", "application/json")
            .timeout_ms(EMBEDDING_REQUEST_TIMEOUT_MS);

    // `if (normalizedSecret) headers.Authorization = …` — an empty secret leaves
    // the header out entirely.
    let normalized_secret = normalize_bearer_secret(secret);
    if !normalized_secret.is_empty() {
        request = request.header("Authorization", &format!("Bearer {normalized_secret}"));
    }
    if provider_id == "openrouter" {
        request = request
            .header("HTTP-Referer", "https://github.com/meco40/openworker")
            .header("X-Title", "BetaClaw");
    }

    let mut body = Map::new();
    body.insert("model".to_string(), Value::String(normalized.model));
    body.insert("input".to_string(), json!(normalized.input));
    // `...(normalized.dimensions ? { dimensions } : {})`.
    if let Some(dimensions) = normalized.dimensions {
        body.insert("dimensions".to_string(), json!(dimensions));
    }

    // `fetchWithTimeout` rejects on a transport failure; nothing catches it, so it
    // escapes `dispatchOpenAICompatibleEmbedding` in TypeScript as well.
    let response = fetch_with_timeout(transport, request.json_body(&Value::Object(body)))
        .await
        .map_err(ServiceError::from)?;
    if !response.is_ok() {
        return Ok(json!({ "error": parse_error_message(&response) }));
    }

    Ok(embedding_response(
        operation,
        openai_compatible_vectors(&parse_json_body_or_empty(&response)),
    ))
}

/// `dispatchCohereEmbedding` from `cohere.ts:6-53`.
///
/// The normalisation is the OpenAI-compatible one (`cohere.ts:4`), so a Cohere
/// payload accepts the same three input shapes.
pub async fn dispatch_cohere_embedding(
    secret: &str,
    operation: &EmbeddingOperation,
    payload: &Value,
    fallback_model: &str,
    transport: &dyn HttpTransport,
) -> Result<Value, ServiceError> {
    let Some(normalized) =
        normalize_openai_compatible_embedding_input(operation, payload, fallback_model)
    else {
        return Ok(json!({ "error": MISSING_MODEL_OR_INPUT_ERROR }));
    };

    let body = json!({
        "model": normalized.model,
        "texts": normalized.input,
        "embedding_types": ["float"],
    });

    // The Authorization header is unconditional here (`cohere.ts:22`), so an empty
    // secret produces the literal `Bearer `.
    let request = HttpRequest::post(COHERE_EMBED_URL)
        .header(
            "Authorization",
            &format!("Bearer {}", normalize_bearer_secret(secret)),
        )
        .header("Content-Type", "application/json")
        .json_body(&body)
        .timeout_ms(EMBEDDING_REQUEST_TIMEOUT_MS);

    let response = fetch_with_timeout(transport, request)
        .await
        .map_err(ServiceError::from)?;
    if !response.is_ok() {
        return Ok(json!({ "error": parse_error_message(&response) }));
    }

    Ok(embedding_response(
        operation,
        cohere_vectors(&parse_json_body_or_empty(&response)),
    ))
}

/// The `baseUrl` argument of `dispatch/embedding.ts:62-73`.
///
/// `ollama` ignores its catalog entry and reads `OLLAMA_BASE_URL`, `lmstudio`
/// prefers `LMSTUDIO_BASE_URL` over the catalog entry, and every other provider
/// uses the catalog entry as-is. [`EnvOverrides::get_or`] mirrors the `||`
/// fallback, so an empty variable falls through like it does in JavaScript.
pub fn openai_compatible_embedding_base_url(
    provider: &ProviderCatalogEntry,
    api_base_url: &str,
    env: &EnvOverrides,
) -> String {
    match provider.id.as_str() {
        "ollama" => format!(
            "{}/v1",
            strip_one_trailing_slash(&env.get_or("OLLAMA_BASE_URL", DEFAULT_OLLAMA_BASE_URL))
        ),
        "lmstudio" => env.get_or("LMSTUDIO_BASE_URL", api_base_url),
        _ => api_base_url.to_string(),
    }
}

/// `dispatchEmbedding` from `service/dispatch/embedding.ts:11-81`.
///
/// The router walks the `p1-embeddings` pipeline in the repository's order,
/// picks the single preferred entry ([`preferred_embedding_entry`] is the ported
/// `filter(status === 'active')` + `sort(priority)` pair), resolves the catalog
/// entry and the account of that entry, and then hands over to the adapter that
/// matches the provider id.
pub async fn dispatch_embedding(
    repository: &dyn ModelHubRepository,
    encryption_key: &str,
    input: &EmbeddingInput,
    dependencies: &ServiceDependencies<'_>,
) -> Result<Value, ServiceError> {
    let pipeline = repository.list_pipeline_models(EMBEDDING_PROFILE_ID)?;
    let Some(preferred_embedding_model) = preferred_embedding_entry(&pipeline) else {
        return Ok(json!({
            "error": "No active embedding model configured. Add one in Gateway Control."
        }));
    };

    let Some(provider) = find_provider(&preferred_embedding_model.provider_id) else {
        return Ok(json!({
            "error": format!(
                "Unknown embedding provider: {}.",
                preferred_embedding_model.provider_id
            )
        }));
    };

    let Some(record) =
        repository.get_account_record_by_id(&preferred_embedding_model.account_id)?
    else {
        return Ok(json!({ "error": "Embedding account record not found." }));
    };

    // `preferredEmbeddingModel.modelName?.trim() || null`.
    let default_embedding_model = match preferred_embedding_model.model_name.trim() {
        "" => None,
        model_name => Some(model_name.to_string()),
    };
    let fallback_model = default_embedding_model.as_deref().unwrap_or("");

    if provider.id != "gemini" {
        if provider.id == "cohere" {
            let secret = decrypt_secret(&record.encrypted_secret_payload(), encryption_key)?;
            if secret.trim().is_empty() {
                return Ok(json!({ "error": "Cohere account secret is missing or empty." }));
            }
            return dispatch_cohere_embedding(
                &secret,
                &input.operation,
                &input.payload,
                fallback_model,
                dependencies.transport,
            )
            .await;
        }

        // `provider.apiBaseUrl` — the catalog stores an absent URL as `None`, and
        // the TypeScript truthiness check also rejects an empty string.
        if let Some(api_base_url) = provider
            .api_base_url
            .as_deref()
            .filter(|url| !url.is_empty())
        {
            let secret = decrypt_secret(&record.encrypted_secret_payload(), encryption_key)?;
            // `!(record.authMethod === 'none' && provider.authMethods.includes('none'))`.
            let keyless_provider_account = record.auth_method == ProviderAuthMethod::None
                && provider.has_auth_method(ProviderAuthMethod::None);
            if secret.trim().is_empty() && !keyless_provider_account {
                return Ok(json!({
                    "error": format!("{} account secret is missing or empty.", provider.id)
                }));
            }
            let base_url =
                openai_compatible_embedding_base_url(provider, api_base_url, dependencies.env);
            return dispatch_openai_compatible_embedding(
                &provider.id,
                &base_url,
                &secret,
                &input.operation,
                &input.payload,
                fallback_model,
                dependencies.transport,
            )
            .await;
        }

        // Unreachable with the current catalog: `gemini` is the only entry without
        // an `apiBaseUrl` (`provider_catalog.rs`, pinned by
        // `only_gemini_has_no_api_base_url`) and it is handled above.
        return Ok(json!({
            "error": format!("Embedding provider \"{}\" is not supported yet.", provider.id)
        }));
    }

    dispatch_gemini_embedding(
        &record,
        encryption_key,
        input,
        default_embedding_model.as_deref(),
        dependencies.transport,
    )
    .await
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::Mutex;

    use http::{Method, StatusCode};

    use super::*;
    use crate::model_hub::crypto::encrypt_secret_with_iv;
    use crate::model_hub::http::{BoxFuture, HttpError};
    use crate::model_hub::service::gateway::NoopObserver;
    use crate::model_hub::service::refresh::NoCodexRefresh;
    use crate::model_hub::service::test_doubles::{no_attachments, StubRepository};
    use crate::model_hub::types::{EncryptedSecretPayloadJson, PipelineModelEntry, PipelineStatus};

    /// The key of `crypto.rs`'s `node> encryptSecret(…)` transcript.
    const KEY: &str = "test-only-encryption-key-32bytes";
    /// The secret `service-embeddings.test.ts` mocks `decryptSecret` to return.
    const SECRET: &str = "gemini-secret";

    /// A transport that replays scripted responses and records every request,
    /// modelled on the stub in `providers/gemini.rs`.
    ///
    /// An exhausted queue answers with a transport failure instead of an empty
    /// success, so a test that expects "no request was sent" fails loudly.
    struct StubTransport {
        responses: Mutex<VecDeque<Result<HttpResponse, HttpError>>>,
        seen: Mutex<Vec<HttpRequest>>,
    }

    impl StubTransport {
        fn new(responses: Vec<Result<HttpResponse, HttpError>>) -> Self {
            Self {
                responses: Mutex::new(responses.into()),
                seen: Mutex::new(Vec::new()),
            }
        }

        fn json(status: StatusCode, value: &Value) -> Self {
            Self::new(vec![Ok(HttpResponse::json(status, value))])
        }

        fn text(status: StatusCode, body: &str) -> Self {
            Self::new(vec![Ok(HttpResponse::text(status, body))])
        }

        fn failing(error: HttpError) -> Self {
            Self::new(vec![Err(error)])
        }

        fn requests(&self) -> Vec<HttpRequest> {
            self.seen.lock().expect("lock").clone()
        }

        /// The single request the transport saw, as `(url, body)`.
        fn only_request(&self) -> (String, Value) {
            let requests = self.requests();
            assert_eq!(requests.len(), 1, "exactly one request");
            let request = &requests[0];
            let body = request
                .body
                .as_deref()
                .map(|body| serde_json::from_str::<Value>(body).expect("json body"))
                .unwrap_or(Value::Null);
            (request.url.clone(), body)
        }
    }

    impl HttpTransport for StubTransport {
        fn send<'a>(
            &'a self,
            request: HttpRequest,
        ) -> BoxFuture<'a, Result<HttpResponse, HttpError>> {
            self.seen.lock().expect("lock").push(request.clone());
            let response = self
                .responses
                .lock()
                .expect("lock")
                .pop_front()
                .unwrap_or_else(|| {
                    Err(HttpError::Transport(
                        "no scripted response left".to_string(),
                    ))
                });
            Box::pin(async move { response })
        }
    }

    fn dependencies<'a>(
        transport: &'a StubTransport,
        env: &'a EnvOverrides,
    ) -> ServiceDependencies<'a> {
        static NO_OBSERVER: NoopObserver = NoopObserver;
        static NO_CODEX_REFRESH: NoCodexRefresh = NoCodexRefresh;
        ServiceDependencies {
            transport,
            attachments: no_attachments(),
            observer: &NO_OBSERVER,
            env,
            codex: &NO_CODEX_REFRESH,
        }
    }

    fn account(
        provider_id: &str,
        secret: &str,
        auth_method: ProviderAuthMethod,
    ) -> ProviderAccountRecord {
        let encrypted =
            encrypt_secret_with_iv(secret, KEY, "default", &[7u8; 12]).expect("encrypt");
        ProviderAccountRecord {
            id: format!("acc-{provider_id}"),
            provider_id: provider_id.to_string(),
            label: provider_id.to_string(),
            auth_method,
            secret_masked: "****".to_string(),
            has_refresh_token: false,
            created_at: "2026-02-23T00:00:00.000Z".to_string(),
            updated_at: "2026-02-23T00:00:00.000Z".to_string(),
            last_check_at: None,
            last_check_ok: None,
            last_check_message: None,
            encrypted_secret: EncryptedSecretPayloadJson::from_payload(&encrypted),
            encrypted_refresh_token: None,
        }
    }

    /// `buildEmbeddingPipelineEntry` of `service-embeddings.test.ts:41-53`.
    fn entry(provider_id: &str, account_id: &str, model_name: &str) -> PipelineModelEntry {
        PipelineModelEntry {
            id: "embed-1".to_string(),
            profile_id: EMBEDDING_PROFILE_ID.to_string(),
            account_id: account_id.to_string(),
            provider_id: provider_id.to_string(),
            model_name: model_name.to_string(),
            reasoning_effort: None,
            priority: 1,
            status: PipelineStatus::Active,
            created_at: "2026-02-23T00:00:00.000Z".to_string(),
            updated_at: "2026-02-23T00:00:00.000Z".to_string(),
        }
    }

    fn embed_content(payload: Value) -> EmbeddingInput {
        EmbeddingInput {
            operation: EmbeddingOperation::EmbedContent,
            payload,
        }
    }

    fn batch_embed_contents(payload: Value) -> EmbeddingInput {
        EmbeddingInput {
            operation: EmbeddingOperation::BatchEmbedContents,
            payload,
        }
    }

    /// The `p1-embeddings` pipeline of a Gemini account with the catalog model of
    /// `buildEmbeddingPipelineEntry`.
    fn gemini_repository() -> StubRepository {
        StubRepository::default()
            .with_accounts(vec![account("gemini", SECRET, ProviderAuthMethod::ApiKey)])
            .with_pipeline(vec![entry("gemini", "acc-gemini", "text-embedding-004")])
    }

    /// `service-embeddings.test.ts:236` — "uses active embedding pipeline model
    /// when payload.model is missing". The payload reaches the SDK as
    /// `{ model: 'text-embedding-004', contents: ['hello'] }`; on the wire that is
    /// `models/text-embedding-004:batchEmbedContents` (see the module header).
    #[tokio::test]
    async fn gemini_uses_the_pipeline_default_model_when_the_payload_has_none() {
        let repository = gemini_repository();
        let transport = StubTransport::json(
            StatusCode::OK,
            &json!({ "embeddings": [{ "values": [3, 2, 1] }] }),
        );
        let env = EnvOverrides::new();
        let deps = dependencies(&transport, &env);

        let result = dispatch_embedding(
            &repository,
            KEY,
            &embed_content(json!({ "contents": ["hello"] })),
            &deps,
        )
        .await
        .expect("dispatch");

        assert_eq!(result, json!({ "embeddings": [{ "values": [3, 2, 1] }] }));
        let requests = transport.requests();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].method, Method::POST);
        assert_eq!(
            requests[0].url,
            "https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:batchEmbedContents"
        );
        assert_eq!(
            requests[0].headers.get("x-goog-api-key").expect("key"),
            SECRET
        );
        assert_eq!(
            requests[0]
                .headers
                .get("content-type")
                .expect("content type"),
            "application/json"
        );
        assert_eq!(
            requests[0].timeout_ms, DEFAULT_REQUEST_TIMEOUT_MS,
            "the SDK call carries no deadline of its own"
        );
        assert_eq!(
            serde_json::from_str::<Value>(requests[0].body.as_deref().expect("body"))
                .expect("json"),
            json!({
                "requests": [{
                    "content": { "role": "user", "parts": [{ "text": "hello" }] },
                    "model": "models/text-embedding-004",
                }]
            })
        );
    }

    /// `service-embeddings.test.ts:214` — "dispatches embedContent operation
    /// directly": a payload-carried model wins over the pipeline default.
    #[tokio::test]
    async fn gemini_keeps_the_payload_model_and_contents_array() {
        let repository = gemini_repository();
        let transport = StubTransport::json(
            StatusCode::OK,
            &json!({ "embeddings": [{ "values": [0.1, 0.2] }] }),
        );
        let env = EnvOverrides::new();
        let deps = dependencies(&transport, &env);

        let result = dispatch_embedding(
            &repository,
            KEY,
            &embed_content(json!({
                "model": "text-embedding-004",
                "contents": ["hello world"],
            })),
            &deps,
        )
        .await
        .expect("dispatch");

        assert_eq!(result, json!({ "embeddings": [{ "values": [0.1, 0.2] }] }));
        let (url, body) = transport.only_request();
        assert!(url.ends_with("/models/text-embedding-004:batchEmbedContents"));
        assert_eq!(
            body,
            json!({
                "requests": [{
                    "content": { "role": "user", "parts": [{ "text": "hello world" }] },
                    "model": "models/text-embedding-004",
                }]
            })
        );
    }

    /// The unknown operation is echoed verbatim (`service-embeddings.test.ts:347`)
    /// and nothing is sent.
    #[tokio::test]
    async fn gemini_echoes_an_unknown_operation() {
        let repository = gemini_repository();
        let transport = StubTransport::json(StatusCode::OK, &json!({}));
        let env = EnvOverrides::new();
        let deps = dependencies(&transport, &env);

        let input = EmbeddingInput {
            operation: EmbeddingOperation::Other("unknown".to_string()),
            payload: json!({}),
        };
        let result = dispatch_embedding(&repository, KEY, &input, &deps)
            .await
            .expect("dispatch");

        assert_eq!(
            result,
            json!({ "error": "Unknown embedding operation: unknown" })
        );
        assert!(transport.requests().is_empty());
    }

    /// `service-embeddings.test.ts:198` — "returns error when decrypted Gemini
    /// secret is empty": the trim decides and the SDK is never reached.
    #[tokio::test]
    async fn gemini_reports_an_empty_secret() {
        let repository = StubRepository::default()
            .with_accounts(vec![account("gemini", "  ", ProviderAuthMethod::ApiKey)])
            .with_pipeline(vec![entry("gemini", "acc-gemini", "text-embedding-004")]);
        let transport = StubTransport::json(StatusCode::OK, &json!({}));
        let env = EnvOverrides::new();
        let deps = dependencies(&transport, &env);

        let result = dispatch_embedding(
            &repository,
            KEY,
            &embed_content(json!({ "model": "text-embedding-004", "contents": ["hello"] })),
            &deps,
        )
        .await
        .expect("dispatch");

        assert_eq!(
            result,
            json!({ "error": "Gemini account secret is missing or empty." })
        );
        assert!(transport.requests().is_empty());
    }

    /// A secret that cannot be decrypted escapes as `Err`, because `decryptSecret`
    /// sits in front of the `try` of `gemini.ts:31`.
    #[tokio::test]
    async fn gemini_reports_a_secret_that_cannot_be_decrypted() {
        let mut record = account("gemini", SECRET, ProviderAuthMethod::ApiKey);
        record.encrypted_secret.iv = "not-base64!".to_string();
        let repository = StubRepository::default()
            .with_accounts(vec![record])
            .with_pipeline(vec![entry("gemini", "acc-gemini", "text-embedding-004")]);
        let transport = StubTransport::json(StatusCode::OK, &json!({}));
        let env = EnvOverrides::new();
        let deps = dependencies(&transport, &env);

        let error = dispatch_embedding(
            &repository,
            KEY,
            &embed_content(json!({ "contents": ["hello"] })),
            &deps,
        )
        .await
        .expect_err("malformed payload");

        assert!(matches!(error, ServiceError::Crypto(_)), "{error:?}");
    }

    /// `service-embeddings.test.ts:290` — "falls back from batchEmbedContents to
    /// embedContent by extracting payload contents": the extracted
    /// `{ model, contents }` pair is what reaches the SDK.
    #[tokio::test]
    async fn gemini_batch_falls_back_to_the_extracted_contents() {
        let repository = gemini_repository();
        let transport = StubTransport::json(
            StatusCode::OK,
            &json!({ "embeddings": [{ "values": [9, 9, 9] }] }),
        );
        let env = EnvOverrides::new();
        let deps = dependencies(&transport, &env);

        let result = dispatch_embedding(
            &repository,
            KEY,
            &batch_embed_contents(json!({
                "requests": [
                    { "model": " text-embedding-004 ", "contents": ["alpha", { "parts": [{ "text": "beta" }] }] },
                    { "model": "text-embedding-004", "content": { "parts": [{ "text": "gamma" }] } },
                ]
            })),
            &deps,
        )
        .await
        .expect("dispatch");

        assert_eq!(result, json!({ "embeddings": [{ "values": [9, 9, 9] }] }));
        let (url, body) = transport.only_request();
        assert!(url.ends_with("/models/text-embedding-004:batchEmbedContents"));
        assert_eq!(
            body,
            json!({
                "requests": [
                    { "content": { "role": "user", "parts": [{ "text": "alpha" }] }, "model": "models/text-embedding-004" },
                    { "content": { "role": "user", "parts": [{ "text": "beta" }] }, "model": "models/text-embedding-004" },
                    { "content": { "role": "user", "parts": [{ "text": "gamma" }] }, "model": "models/text-embedding-004" },
                ]
            })
        );
    }

    /// `service-embeddings.test.ts:326` — "returns empty embeddings when batch
    /// fallback payload is not extractable".
    #[tokio::test]
    async fn gemini_batch_reports_empty_embeddings_for_an_inextricable_payload() {
        let repository = gemini_repository();
        let transport = StubTransport::json(StatusCode::OK, &json!({}));
        let env = EnvOverrides::new();
        let deps = dependencies(&transport, &env);

        let result = dispatch_embedding(
            &repository,
            KEY,
            &batch_embed_contents(json!({
                "requests": [{ "model": "text-embedding-004", "contents": [] }]
            })),
            &deps,
        )
        .await
        .expect("dispatch");

        assert_eq!(result, json!({ "embeddings": [] }));
        assert!(transport.requests().is_empty());
    }

    /// The payload shape `world-model/embeddings/provider.ts:53-55` and
    /// `mem0EmbedderSync.ts:210` actually send: `{ model, input }`. The SDK's
    /// transformer reads `contents`/`content` only, so the missing `contents`
    /// trips the `requests[]` writer of `setValueByPath` — the message the SDK
    /// throws and `gemini.ts:54` reports.
    #[tokio::test]
    async fn gemini_reports_the_sdk_writer_error_for_an_input_only_payload() {
        let repository = gemini_repository();
        let transport = StubTransport::json(StatusCode::OK, &json!({}));
        let env = EnvOverrides::new();
        let deps = dependencies(&transport, &env);

        let result = dispatch_embedding(
            &repository,
            KEY,
            &embed_content(json!({
                "model": "text-embedding-004",
                "input": "local memory",
            })),
            &deps,
        )
        .await
        .expect("dispatch");

        assert_eq!(
            result,
            json!({ "error": "Value must be a list given an array path requests[]" })
        );
        assert!(transport.requests().is_empty());
    }

    /// Without a payload model and without a pipeline model the `formatMap`
    /// template throws, because `_url.model` stays unset.
    #[tokio::test]
    async fn gemini_reports_the_missing_url_key() {
        let repository = StubRepository::default()
            .with_accounts(vec![account("gemini", SECRET, ProviderAuthMethod::ApiKey)])
            .with_pipeline(vec![entry("gemini", "acc-gemini", "")]);
        let transport = StubTransport::json(StatusCode::OK, &json!({}));
        let env = EnvOverrides::new();
        let deps = dependencies(&transport, &env);

        let result = dispatch_embedding(
            &repository,
            KEY,
            &embed_content(json!({ "contents": ["hello"] })),
            &deps,
        )
        .await
        .expect("dispatch");

        assert_eq!(
            result,
            json!({ "error": "Key 'model' not found in valueMap." })
        );
        assert!(transport.requests().is_empty());
    }

    /// A `config` field the Gemini API does not support fails before the request
    /// is built (`dist/index.mjs:12177-12186`).
    #[tokio::test]
    async fn gemini_rejects_an_unsupported_config_field() {
        let repository = gemini_repository();
        let transport = StubTransport::json(StatusCode::OK, &json!({}));
        let env = EnvOverrides::new();
        let deps = dependencies(&transport, &env);

        let result = dispatch_embedding(
            &repository,
            KEY,
            &embed_content(json!({
                "model": "text-embedding-004",
                "contents": ["hello"],
                "config": { "taskType": "RETRIEVAL_DOCUMENT", "autoTruncate": true },
            })),
            &deps,
        )
        .await
        .expect("dispatch");

        assert_eq!(
            result,
            json!({ "error": "autoTruncate parameter is not supported in Gemini API." })
        );
        assert!(transport.requests().is_empty());
    }

    /// A supported `config.taskType` lands on every `requests[]` entry.
    #[tokio::test]
    async fn gemini_copies_the_config_task_type_onto_every_request() {
        let repository = gemini_repository();
        let transport = StubTransport::json(
            StatusCode::OK,
            &json!({ "embeddings": [{ "values": [1] }] }),
        );
        let env = EnvOverrides::new();
        let deps = dependencies(&transport, &env);

        dispatch_embedding(
            &repository,
            KEY,
            &embed_content(json!({
                "model": "text-embedding-004",
                "contents": ["a", "b"],
                "config": { "taskType": "RETRIEVAL_DOCUMENT" },
            })),
            &deps,
        )
        .await
        .expect("dispatch");

        let (_, body) = transport.only_request();
        assert_eq!(
            body,
            json!({
                "requests": [
                    { "content": { "role": "user", "parts": [{ "text": "a" }] }, "taskType": "RETRIEVAL_DOCUMENT", "model": "models/text-embedding-004" },
                    { "content": { "role": "user", "parts": [{ "text": "b" }] }, "taskType": "RETRIEVAL_DOCUMENT", "model": "models/text-embedding-004" },
                ]
            })
        );
    }

    /// A failed Gemini call reports the SDK's `JSON.stringify(await
    /// response.json())` message (`dist/index.mjs:7512-7536`).
    #[tokio::test]
    async fn gemini_reports_the_serialised_api_error_body() {
        let repository = gemini_repository();
        let transport = StubTransport::json(
            StatusCode::BAD_REQUEST,
            &json!({
                "error": {
                    "code": 400,
                    "message": "Invalid JSON payload",
                    "status": "INVALID_ARGUMENT",
                }
            }),
        );
        let env = EnvOverrides::new();
        let deps = dependencies(&transport, &env);

        let result = dispatch_embedding(
            &repository,
            KEY,
            &embed_content(json!({ "model": "text-embedding-004", "contents": ["hello"] })),
            &deps,
        )
        .await
        .expect("dispatch");

        assert_eq!(
            result,
            json!({
                "error": "{\"error\":{\"code\":400,\"message\":\"Invalid JSON payload\",\"status\":\"INVALID_ARGUMENT\"}}"
            })
        );
    }

    /// A failed Gemini call without a JSON content type synthesises
    /// `{ error: { message, code, status } }` (`dist/index.mjs:7520-7527`).
    #[tokio::test]
    async fn gemini_reports_a_synthesised_error_body() {
        let repository = gemini_repository();
        let transport = StubTransport::text(StatusCode::BAD_GATEWAY, "upstream died");
        let env = EnvOverrides::new();
        let deps = dependencies(&transport, &env);

        let result = dispatch_embedding(
            &repository,
            KEY,
            &embed_content(json!({ "model": "text-embedding-004", "contents": ["hello"] })),
            &deps,
        )
        .await
        .expect("dispatch");

        assert_eq!(
            result,
            json!({
                "error": "{\"error\":{\"message\":\"upstream died\",\"code\":502,\"status\":\"Bad Gateway\"}}"
            })
        );
    }

    /// The `try { … } catch` of `gemini.ts:53-56` turns a transport failure into
    /// `{ error: message }` instead of letting it escape.
    #[tokio::test]
    async fn gemini_turns_a_transport_failure_into_an_error_record() {
        let repository = gemini_repository();
        let transport = StubTransport::failing(HttpError::Transport("socket closed".to_string()));
        let env = EnvOverrides::new();
        let deps = dependencies(&transport, &env);

        let result = dispatch_embedding(
            &repository,
            KEY,
            &embed_content(json!({ "model": "text-embedding-004", "contents": ["hello"] })),
            &deps,
        )
        .await
        .expect("dispatch");

        assert_eq!(result, json!({ "error": "socket closed" }));
    }

    /// A `200` whose body is not JSON is the SDK's `response.json()` rejection.
    #[tokio::test]
    async fn gemini_reports_an_unparsable_success_body() {
        let repository = gemini_repository();
        let transport = StubTransport::text(StatusCode::OK, "<html>nope</html>");
        let env = EnvOverrides::new();
        let deps = dependencies(&transport, &env);

        let result = dispatch_embedding(
            &repository,
            KEY,
            &embed_content(json!({ "model": "text-embedding-004", "contents": ["hello"] })),
            &deps,
        )
        .await
        .expect("dispatch");

        let error = result
            .get("error")
            .and_then(Value::as_str)
            .expect("an error message");
        assert!(error.contains("expected value"), "{error}");
    }

    /// `normalizeOpenAICompatibleEmbeddingInput` (`openaiCompatible.ts:10-58`),
    /// including the `||` fallbacks and the `dimensions` rule of
    /// `service-embeddings.test.ts:437`.
    #[test]
    fn normalize_prefers_the_payload_model_and_walks_the_input_shapes() {
        let operation = EmbeddingOperation::EmbedContent;

        // A string input is trimmed and wrapped in a one-element list.
        assert_eq!(
            normalize_openai_compatible_embedding_input(
                &operation,
                &json!({ "model": " m ", "input": "  hello  ", "dimensions": 1536 }),
                "fallback"
            ),
            Some(NormalizedEmbeddingInput {
                model: "m".to_string(),
                input: vec!["hello".to_string()],
                dimensions: Some(1536),
            })
        );

        // An array input drops non-strings and empty entries.
        assert_eq!(
            normalize_openai_compatible_embedding_input(
                &operation,
                &json!({ "input": [" a ", 7, "", "  ", "b"] }),
                " fallback "
            ),
            Some(NormalizedEmbeddingInput {
                model: "fallback".to_string(),
                input: vec!["a".to_string(), "b".to_string()],
                dimensions: None,
            })
        );

        // `dimensions` must be a positive number; `asPositiveInteger` decides.
        assert_eq!(
            normalize_openai_compatible_embedding_input(
                &operation,
                &json!({ "input": "a", "dimensions": 0 }),
                "fallback"
            )
            .expect("normalized")
            .dimensions,
            None
        );

        // `contents` (Gemini shape) is the embedContent fallback.
        assert_eq!(
            normalize_openai_compatible_embedding_input(
                &operation,
                &json!({ "contents": [{ "parts": [{ "text": " from parts " }] }, "from string"] }),
                "fallback"
            ),
            Some(NormalizedEmbeddingInput {
                model: "fallback".to_string(),
                input: vec!["from parts".to_string(), "from string".to_string()],
                dimensions: None,
            })
        );

        // `content` (singular) follows `contents`.
        assert_eq!(
            normalize_openai_compatible_embedding_input(
                &operation,
                &json!({ "content": " from content " }),
                "fallback"
            ),
            Some(NormalizedEmbeddingInput {
                model: "fallback".to_string(),
                input: vec!["from content".to_string()],
                dimensions: None,
            })
        );

        // No model at all is `null`.
        assert_eq!(
            normalize_openai_compatible_embedding_input(
                &operation,
                &json!({ "input": "hello" }),
                "   "
            ),
            None
        );
        // An `embedContent` payload without any input shape is `null`.
        assert_eq!(
            normalize_openai_compatible_embedding_input(&operation, &json!({}), "fallback"),
            None
        );
        // An empty `input` array is not an input shape either.
        assert_eq!(
            normalize_openai_compatible_embedding_input(
                &EmbeddingOperation::BatchEmbedContents,
                &json!({ "input": [], "model": "m" }),
                "fallback"
            ),
            None
        );
    }

    /// For a batch operation the extractor's model wins when the payload has
    /// none, and its contents become the input (`openaiCompatible.ts:46-53`).
    #[test]
    fn normalize_uses_the_batch_extraction_for_other_operations() {
        let normalized = normalize_openai_compatible_embedding_input(
            &EmbeddingOperation::BatchEmbedContents,
            &json!({
                "requests": [{ "model": " text-embedding-004 ", "contents": ["alpha"] }]
            }),
            "fallback",
        )
        .expect("normalized");

        assert_eq!(normalized.model, "text-embedding-004");
        assert_eq!(normalized.input, vec!["alpha".to_string()]);

        // The payload model still wins over the extracted one.
        let normalized = normalize_openai_compatible_embedding_input(
            &EmbeddingOperation::BatchEmbedContents,
            &json!({
                "model": "payload-model",
                "requests": [{ "model": "text-embedding-004", "contents": ["alpha"] }]
            }),
            "fallback",
        )
        .expect("normalized");
        assert_eq!(normalized.model, "payload-model");

        // An unknown operation is not `embedContent`, so it follows the batch
        // order and can still read a final `contents`.
        let normalized = normalize_openai_compatible_embedding_input(
            &EmbeddingOperation::Other("unknown".to_string()),
            &json!({ "model": "m", "contents": ["alpha"] }),
            "fallback",
        )
        .expect("normalized");
        assert_eq!(normalized.input, vec!["alpha".to_string()]);
    }

    /// The Cohere request of `cohere.ts:17-32` and both response shapes of
    /// `cohere.ts:38-52`.
    #[tokio::test]
    async fn cohere_posts_the_v2_embed_body() {
        let transport = StubTransport::new(vec![
            Ok(HttpResponse::json(
                StatusCode::OK,
                &json!({ "embeddings": { "float": [[0.1, 0.2]] } }),
            )),
            Ok(HttpResponse::json(
                StatusCode::OK,
                &json!({ "embeddings": [[0.3, 0.4], [], "nope"] }),
            )),
        ]);

        let single = dispatch_cohere_embedding(
            "Bearer co-secret",
            &EmbeddingOperation::EmbedContent,
            &json!({ "model": "embed-english-v3.0", "input": ["hello"] }),
            "",
            &transport,
        )
        .await
        .expect("dispatch");

        assert_eq!(single, json!({ "embedding": { "values": [0.1, 0.2] } }));

        let batch = dispatch_cohere_embedding(
            "co-secret",
            &EmbeddingOperation::BatchEmbedContents,
            &json!({ "model": "embed-english-v3.0", "input": ["hello"] }),
            "",
            &transport,
        )
        .await
        .expect("dispatch");

        // The flat `embeddings` array is accepted, and the empty entry and the
        // non-array entry are dropped (`cohere.ts:45-47`).
        assert_eq!(batch, json!({ "embeddings": [{ "values": [0.3, 0.4] }] }));

        let requests = transport.requests();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0].url, COHERE_EMBED_URL);
        assert_eq!(requests[0].method, Method::POST);
        assert_eq!(
            requests[0].headers.get("authorization").expect("auth"),
            "Bearer co-secret",
            "`normalizeBearerSecret` strips an existing Bearer prefix"
        );
        assert_eq!(
            requests[0]
                .headers
                .get("content-type")
                .expect("content type"),
            "application/json"
        );
        assert_eq!(requests[0].timeout_ms, EMBEDDING_REQUEST_TIMEOUT_MS);
        assert_eq!(
            serde_json::from_str::<Value>(requests[0].body.as_deref().expect("body"))
                .expect("json"),
            json!({
                "model": "embed-english-v3.0",
                "texts": ["hello"],
                "embedding_types": ["float"],
            })
        );
        assert_eq!(
            serde_json::from_str::<Value>(requests[1].body.as_deref().expect("body"))
                .expect("json"),
            json!({
                "model": "embed-english-v3.0",
                "texts": ["hello"],
                "embedding_types": ["float"],
            })
        );
    }

    /// `cohere.ts:12-15`: a payload without a usable model or input shape answers
    /// the shared error and never reaches the network.
    #[tokio::test]
    async fn cohere_reports_an_unusable_payload() {
        let transport = StubTransport::json(StatusCode::OK, &json!({}));

        let result = dispatch_cohere_embedding(
            "co-secret",
            &EmbeddingOperation::EmbedContent,
            &json!({ "input": ["hello"] }),
            "",
            &transport,
        )
        .await
        .expect("dispatch");

        assert_eq!(result, json!({ "error": MISSING_MODEL_OR_INPUT_ERROR }));
        assert!(transport.requests().is_empty());
    }

    /// `cohere.ts:34-36` reuses `parseErrorMessage` for a failed call.
    #[tokio::test]
    async fn cohere_reports_the_parsed_error_message() {
        let transport = StubTransport::json(
            StatusCode::TOO_MANY_REQUESTS,
            &json!({ "message": "too many requests" }),
        );

        let result = dispatch_cohere_embedding(
            "co-secret",
            &EmbeddingOperation::EmbedContent,
            &json!({ "model": "embed-english-v3.0", "input": ["hello"] }),
            "",
            &transport,
        )
        .await
        .expect("dispatch");

        assert_eq!(result, json!({ "error": "too many requests" }));
    }

    /// `service-embeddings.test.ts:385` — "dispatches embedContent through
    /// openai-compatible embedding endpoint for openrouter", including the two
    /// extra headers of `openaiCompatible.ts:80-83`.
    #[tokio::test]
    async fn openai_compatible_posts_the_openrouter_request() {
        let transport = StubTransport::json(
            StatusCode::OK,
            &json!({ "data": [{ "embedding": [0.11, 0.22, 0.33], "index": 0 }] }),
        );

        let result = dispatch_openai_compatible_embedding(
            "openrouter",
            "https://openrouter.ai/api/v1",
            "or-secret",
            &EmbeddingOperation::EmbedContent,
            &json!({ "contents": ["hello openrouter"] }),
            "openai/text-embedding-3-small",
            &transport,
        )
        .await
        .expect("dispatch");

        assert_eq!(
            result,
            json!({ "embedding": { "values": [0.11, 0.22, 0.33] } })
        );

        let requests = transport.requests();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].url, "https://openrouter.ai/api/v1/embeddings");
        assert_eq!(requests[0].method, Method::POST);
        assert_eq!(
            requests[0].headers.get("authorization").expect("auth"),
            "Bearer or-secret"
        );
        assert_eq!(
            requests[0].headers.get("http-referer").expect("referer"),
            "https://github.com/meco40/openworker"
        );
        assert_eq!(
            requests[0].headers.get("x-title").expect("title"),
            "BetaClaw"
        );
        assert_eq!(requests[0].timeout_ms, EMBEDDING_REQUEST_TIMEOUT_MS);
        assert_eq!(
            serde_json::from_str::<Value>(requests[0].body.as_deref().expect("body"))
                .expect("json"),
            json!({
                "model": "openai/text-embedding-3-small",
                "input": ["hello openrouter"],
            })
        );
    }

    /// `service-embeddings.test.ts:437` — "forwards dimensions for
    /// openai-compatible embedding payloads", with a base URL that carries a
    /// trailing slash that must disappear exactly once.
    #[tokio::test]
    async fn openai_compatible_forwards_dimensions_and_strips_one_slash() {
        let transport = StubTransport::json(
            StatusCode::OK,
            &json!({ "data": [{ "embedding": [0.1, 0.2], "index": 0 }] }),
        );

        let result = dispatch_openai_compatible_embedding(
            "openai",
            "https://api.example.com/v1/",
            "",
            &EmbeddingOperation::EmbedContent,
            &json!({ "contents": ["hello"], "dimensions": 1536 }),
            "qwen/qwen3-embedding-8b",
            &transport,
        )
        .await
        .expect("dispatch");

        assert_eq!(result, json!({ "embedding": { "values": [0.1, 0.2] } }));

        let requests = transport.requests();
        assert_eq!(requests[0].url, "https://api.example.com/v1/embeddings");
        assert!(
            requests[0].headers.get("authorization").is_none(),
            "an empty secret adds no Authorization header"
        );
        assert!(
            requests[0].headers.get("http-referer").is_none(),
            "only openrouter gets the extra headers"
        );
        assert_eq!(
            serde_json::from_str::<Value>(requests[0].body.as_deref().expect("body"))
                .expect("json"),
            json!({
                "model": "qwen/qwen3-embedding-8b",
                "input": ["hello"],
                "dimensions": 1536,
            })
        );
    }

    /// `openaiCompatible.ts:104-111`: entries without an `embedding` array and
    /// empty vectors are dropped; the batch shape wraps every survivor.
    #[tokio::test]
    async fn openai_compatible_filters_the_response_entries() {
        let transport = StubTransport::json(
            StatusCode::OK,
            &json!({
                "data": [
                    { "embedding": [] },
                    { "index": 1 },
                    { "embedding": [1, 2] },
                    "not-an-object",
                ]
            }),
        );

        let result = dispatch_openai_compatible_embedding(
            "openai",
            "https://api.example.com/v1",
            "",
            &EmbeddingOperation::BatchEmbedContents,
            &json!({ "model": "m", "input": ["a"] }),
            "",
            &transport,
        )
        .await
        .expect("dispatch");

        assert_eq!(result, json!({ "embeddings": [{ "values": [1, 2] }] }));
    }

    /// `openaiCompatible.ts:99-101`.
    #[tokio::test]
    async fn openai_compatible_reports_the_parsed_error_message() {
        let transport =
            StubTransport::json(StatusCode::BAD_REQUEST, &json!({ "error": "bad model" }));

        let result = dispatch_openai_compatible_embedding(
            "openai",
            "https://api.example.com/v1",
            "s",
            &EmbeddingOperation::EmbedContent,
            &json!({ "model": "m", "input": "a" }),
            "",
            &transport,
        )
        .await
        .expect("dispatch");

        assert_eq!(result, json!({ "error": "bad model" }));
    }

    /// Nothing catches a transport failure on this path, so it escapes as `Err`
    /// (`openaiCompatible.ts:85`, `cohere.ts:17`).
    #[tokio::test]
    async fn the_rest_adapters_let_a_transport_failure_escape() {
        let transport =
            StubTransport::failing(HttpError::Transport("connection reset".to_string()));

        let error = dispatch_openai_compatible_embedding(
            "openai",
            "https://api.example.com/v1",
            "s",
            &EmbeddingOperation::EmbedContent,
            &json!({ "model": "m", "input": "a" }),
            "",
            &transport,
        )
        .await
        .expect_err("transport failure");

        assert!(matches!(error, ServiceError::Transport(_)), "{error:?}");
    }

    /// `service-embeddings.test.ts:133` — "uses the configured %s endpoint without
    /// an API key": a keyless account skips the secret check and the ollama URL is
    /// `OLLAMA_BASE_URL` plus `/v1`, with one trailing slash removed.
    #[tokio::test]
    async fn router_sends_a_keyless_ollama_account_to_the_configured_host() {
        let repository = StubRepository::default()
            .with_accounts(vec![account("ollama", "", ProviderAuthMethod::None)])
            .with_pipeline(vec![entry("ollama", "acc-ollama", "local-embedding")]);
        let transport = StubTransport::json(
            StatusCode::OK,
            &json!({ "data": [{ "embedding": [0.1, 0.2] }] }),
        );
        let env = EnvOverrides::new().with("OLLAMA_BASE_URL", "http://model-host:11434/");
        let deps = dependencies(&transport, &env);

        let result = dispatch_embedding(
            &repository,
            KEY,
            &embed_content(json!({ "contents": ["local memory"] })),
            &deps,
        )
        .await
        .expect("dispatch");

        assert_eq!(result, json!({ "embedding": { "values": [0.1, 0.2] } }));
        let requests = transport.requests();
        assert_eq!(requests[0].url, "http://model-host:11434/v1/embeddings");
        assert!(
            requests[0].headers.get("authorization").is_none(),
            "no secret means no Authorization header"
        );
        assert_eq!(
            serde_json::from_str::<Value>(requests[0].body.as_deref().expect("body"))
                .expect("json"),
            json!({ "model": "local-embedding", "input": ["local memory"] })
        );
    }

    /// The ollama fallback and the lmstudio override of
    /// `dispatch/embedding.ts:64-67`.
    #[test]
    fn base_url_resolution_follows_the_typescript_ternary() {
        let ollama = find_provider("ollama").expect("ollama is in the catalog");
        let lmstudio = find_provider("lmstudio").expect("lmstudio is in the catalog");
        let openai = find_provider("openai").expect("openai is in the catalog");

        // An unset variable falls back to the literal default.
        assert_eq!(
            openai_compatible_embedding_base_url(
                ollama,
                ollama.api_base_url.as_deref().expect("base url"),
                &EnvOverrides::new(),
            ),
            "http://localhost:11434/v1"
        );

        // `||` treats an empty variable as absent.
        assert_eq!(
            openai_compatible_embedding_base_url(
                ollama,
                "http://catalog:11434/v1",
                &EnvOverrides::new().with("OLLAMA_BASE_URL", ""),
            ),
            "http://localhost:11434/v1"
        );

        // lmstudio prefers its own variable over the catalog entry.
        assert_eq!(
            openai_compatible_embedding_base_url(
                lmstudio,
                "http://localhost:1234/v1",
                &EnvOverrides::new().with("LMSTUDIO_BASE_URL", "http://model-host:1234/v1"),
            ),
            "http://model-host:1234/v1"
        );

        // Every other provider uses the catalog entry unchanged.
        assert_eq!(
            openai_compatible_embedding_base_url(
                openai,
                "https://api.openai.com/v1",
                &EnvOverrides::new(),
            ),
            "https://api.openai.com/v1"
        );
    }

    /// The three early exits of `dispatch/embedding.ts:22-36`.
    #[tokio::test]
    async fn router_reports_the_pipeline_and_account_problems() {
        let transport = StubTransport::json(StatusCode::OK, &json!({}));
        let env = EnvOverrides::new();
        let deps = dependencies(&transport, &env);

        // `service-embeddings.test.ts:168`.
        let empty = StubRepository::default();
        assert_eq!(
            dispatch_embedding(
                &empty,
                KEY,
                &embed_content(json!({ "contents": ["hello"] })),
                &deps
            )
            .await
            .expect("dispatch"),
            json!({ "error": "No active embedding model configured. Add one in Gateway Control." })
        );

        // An unknown provider id.
        let unknown = StubRepository::default().with_pipeline(vec![entry("nope", "acc-nope", "m")]);
        assert_eq!(
            dispatch_embedding(
                &unknown,
                KEY,
                &embed_content(json!({ "contents": ["hello"] })),
                &deps
            )
            .await
            .expect("dispatch"),
            json!({ "error": "Unknown embedding provider: nope." })
        );

        // `service-embeddings.test.ts:182`.
        let orphan = StubRepository::default().with_pipeline(vec![entry(
            "gemini",
            "acc-gemini",
            "text-embedding-004",
        )]);
        assert_eq!(
            dispatch_embedding(
                &orphan,
                KEY,
                &embed_content(json!({ "contents": ["hello"] })),
                &deps
            )
            .await
            .expect("dispatch"),
            json!({ "error": "Embedding account record not found." })
        );

        assert!(transport.requests().is_empty());
        assert_eq!(
            empty.pipeline_requests(),
            vec![EMBEDDING_PROFILE_ID.to_string()],
            "the router reads the embedding profile"
        );
    }

    /// The two provider-specific secret messages of
    /// `dispatch/embedding.ts:44` and `:60`.
    #[tokio::test]
    async fn router_reports_the_provider_secret_messages() {
        let transport = StubTransport::json(StatusCode::OK, &json!({}));
        let env = EnvOverrides::new();
        let deps = dependencies(&transport, &env);

        let cohere = StubRepository::default()
            .with_accounts(vec![account("cohere", " ", ProviderAuthMethod::ApiKey)])
            .with_pipeline(vec![entry("cohere", "acc-cohere", "embed-english-v3.0")]);
        assert_eq!(
            dispatch_embedding(
                &cohere,
                KEY,
                &embed_content(json!({ "contents": ["hello"] })),
                &deps
            )
            .await
            .expect("dispatch"),
            json!({ "error": "Cohere account secret is missing or empty." })
        );

        let openai = StubRepository::default()
            .with_accounts(vec![account("openai", "", ProviderAuthMethod::ApiKey)])
            .with_pipeline(vec![entry(
                "openai",
                "acc-openai",
                "text-embedding-3-small",
            )]);
        assert_eq!(
            dispatch_embedding(
                &openai,
                KEY,
                &embed_content(json!({ "contents": ["hello"] })),
                &deps
            )
            .await
            .expect("dispatch"),
            json!({ "error": "openai account secret is missing or empty." })
        );

        assert!(transport.requests().is_empty());
    }

    /// `strip_one_trailing_slash` removes exactly one slash, and `tModel` keeps a
    /// prefix that is already there.
    #[test]
    fn model_path_and_slash_helpers_match_javascript() {
        assert_eq!(strip_one_trailing_slash("http://x/"), "http://x");
        assert_eq!(strip_one_trailing_slash("http://x//"), "http://x/");
        assert_eq!(strip_one_trailing_slash("http://x"), "http://x");

        assert_eq!(
            gemini_model_path(&json!("text-embedding-004")).expect("path"),
            "models/text-embedding-004"
        );
        assert_eq!(
            gemini_model_path(&json!("models/text-embedding-004")).expect("path"),
            "models/text-embedding-004"
        );
        assert_eq!(
            gemini_model_path(&json!("tunedModels/abc")).expect("path"),
            "tunedModels/abc"
        );
        assert_eq!(
            gemini_model_path(&json!("a?b")).expect_err("invalid"),
            "invalid model parameter"
        );
        assert_eq!(
            gemini_model_path(&Value::Null).expect_err("missing"),
            "model is required and must be a string"
        );
        assert_eq!(
            gemini_model_path(&json!(7)).expect_err("not a string"),
            "model is required and must be a string"
        );
    }
}
