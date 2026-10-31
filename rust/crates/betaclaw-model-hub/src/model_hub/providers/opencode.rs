//! Port of `src/server/model-hub/Models/opencode/index.ts` and
//! `src/server/model-hub/Models/opencode/metadata.ts`.
//!
//! | Rust | TypeScript |
//! | --- | --- |
//! | [`PROVIDER_ID`] | `id: 'opencode'` (`opencode/index.ts:10`) |
//! | [`NO_BASE_URL_MESSAGE`] | `'OpenCode has no configured API base URL.'` (`opencode/index.ts:24`, `:42`) |
//! | [`CONNECTIVITY_OK`] | `opencode/index.ts:30` |
//! | [`CONNECTIVITY_FAILURE_PREFIX`] | `opencode/index.ts:31` |
//! | [`OpenCodeAdapter`] | `openCodeProviderAdapter` (`opencode/index.ts:9-51`) |
//! | [`MODELS_DEV_API_URL`] | `metadata.ts:4` |
//! | [`OpenCodeModelMetadata`] | `interface OpenCodeModelMetadata` (`metadata.ts:6-10`) |
//! | [`FALLBACK_METADATA`], [`fallback_metadata`] | `FALLBACK_METADATA` (`metadata.ts:12-15`) |
//! | [`as_record`] | `asRecord` (`metadata.ts:17-19`) |
//! | [`parse_billing`] | `parseBilling` (`metadata.ts:21-33`) |
//! | [`normalize_display_name`] | `normalizeDisplayName` (`metadata.ts:35-38`) |
//! | [`parse_metadata`] | `parseMetadata` (`metadata.ts:40-55`) |
//! | [`fetch_open_code_model_metadata`] | `fetchOpenCodeModelMetadata` (`metadata.ts:57-76`) |
//! | [`enrich_open_code_models`] | `enrichOpenCodeModels` (`metadata.ts:78-96`) |
//!
//! OpenCode is an OpenAI-compatible transport, but it implements none of the three
//! handlers as a pure configuration: `fetchModels` and `testConnectivity` guard on
//! `provider.apiBaseUrl` first (`opencode/index.ts:13`, `:23`) and `fetchModels`
//! enriches the shared `/models` result with the public models.dev catalogue. Only
//! `dispatchGateway` (`opencode/index.ts:46-49`) is the plain shared call. The
//! models endpoint, the auth header and the timeout therefore come from the shared
//! layer unchanged: `buildModelsUrl(apiBaseUrl)`, `buildOptionalAuthHeaders(secret)`
//! and the 15 s default of `fetchWithTimeout`.
//!
//! `apiBaseUrl` is the catalog value `https://opencode.ai/zen/v1`
//! (`providerCatalog.ts`), so a provider entry without it — the field is optional
//! in the contract — is the "no API base URL" case, not a fallback URL.
//!
//! # Deviations from the TypeScript
//!
//! - **`Map` → `BTreeMap`.** `fetchOpenCodeModelMetadata` returns
//!   `Map<string, OpenCodeModelMetadata>` (`metadata.ts:57`). The port returns
//!   [`BTreeMap`], which is a `get`-only lookup for every caller: enrichment keys
//!   off `model.id`, so the iteration order of a JavaScript `Map` is never
//!   observable.
//! - **`typeof value === 'object'` includes arrays.** `asRecord`
//!   (`metadata.ts:17-19`) accepts arrays because `typeof [] === 'object'` and
//!   `[] !== null`, and both `Object.values` and `Object.entries` still work on
//!   them. [`as_record`] returns arrays too, and [`js_object_values`] /
//!   [`js_object_entries`] reproduce the element/`"0"`-key views, so e.g. a
//!   `cost` that is an array is billed by its elements exactly as in JavaScript.
//! - **`Number.isFinite`.** JSON cannot carry `NaN`; an out-of-range exponent
//!   literal is the only way a non-finite number can reach [`parse_billing`], and
//!   the `is_finite` filter keeps the TypeScript behaviour for it.
//! - **`\s` in `/\s+\(Unlimited\)$/i`.** [`normalize_display_name`] uses the
//!   `regex` crate with the same pattern and the `i` flag. JavaScript's `\s` also
//!   matches U+FEFF, which the Unicode `White_Space` set behind the crate's `\s`
//!   does not; only a BOM-padded `(Unlimited)` suffix could tell the two apart.
//! - **Failure of the models.dev call.** `fetchOpenCodeModelMetadata` wraps
//!   everything in `try { … } catch { return new Map() }` (`metadata.ts:58-75`),
//!   including the `response.json()` of a 2xx body. The port maps a transport
//!   failure, a non-2xx status and an undecodable body alike onto an empty
//!   [`BTreeMap`]; the comment at `metadata.ts:73` is the contract — "model
//!   metadata must never prevent the provider's live model list from loading".
//! - **`fetchModels` propagates the shared failure.** There is no
//!   `.catch(() => [])` here, unlike `kimi` and `ollama`, so a rejected
//!   `/models` request — transport failure or undecodable body — escapes
//!   `fetchModels`; `modelFetcher.ts:57-66` catches it and falls back to
//!   `defaultModels`. The port returns `Err(`[`HttpError`]`)` in exactly those
//!   cases and never turns a 2xx-but-empty list into an error (`models.length ===
//!   0` short-circuits before the metadata call, `opencode/index.ts:16`).
//!
//! # SDK usage in the TypeScript
//!
//! None in either file: `opencode/index.ts` uses the shared OpenAI-compatible
//! helpers and `metadata.ts` uses `fetchWithTimeout` against models.dev, so this
//! port is REST against the injected [`HttpTransport`] with no SDK translation.

use std::collections::BTreeMap;
use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;

use crate::model_hub::http::{
    fetch_with_timeout, BoxFuture, HttpError, HttpRequest, HttpTransport,
};
use crate::model_hub::openai_compatible::{
    dispatch_openai_compatible_chat, fetch_openai_compatible_models,
    test_openai_compatible_models_endpoint, DispatchOptions,
};
use crate::model_hub::types::{
    ConnectivityResult, FetchedModel, GatewayRequest, GatewayResponse, ModelBilling,
    ProviderExecutionContext,
};

use super::{ProviderAdapter, ProviderCall};

/// `id: 'opencode'` from `opencode/index.ts:10`.
pub const PROVIDER_ID: &str = "opencode";
/// `https://models.dev/api.json` from `metadata.ts:4`.
pub const MODELS_DEV_API_URL: &str = "https://models.dev/api.json";
/// `'OpenCode has no configured API base URL.'` from `opencode/index.ts:24` and,
/// identically, `opencode/index.ts:42`.
pub const NO_BASE_URL_MESSAGE: &str = "OpenCode has no configured API base URL.";
/// `'OpenCode connectivity verified (models list reachable).'` from
/// `opencode/index.ts:30`.
pub const CONNECTIVITY_OK: &str = "OpenCode connectivity verified (models list reachable).";
/// `'OpenCode connectivity failed: '` from `opencode/index.ts:31`.
pub const CONNECTIVITY_FAILURE_PREFIX: &str = "OpenCode connectivity failed: ";

/// `FALLBACK_METADATA` from `metadata.ts:12-15`: two ids whose display name and
/// free billing come from the source instead of models.dev. Neither entry carries
/// a `context_window`, which is what makes the enrichment chain fall through to
/// the model's own value (`metadata.ts:89-92`).
///
/// The tuple is `(id, name, billing)`; the TypeScript record has no other fields.
const FALLBACK_METADATA: &[(&str, &str, ModelBilling)] = &[
    ("ox-alpha-free", "Ox Alpha Free", ModelBilling::Free),
    ("x-preview-f-free", "Ox Alpha Free", ModelBilling::Free),
];

/// `OpenCodeModelMetadata` from `metadata.ts:6-10`.
///
/// Every field is optional, and `parseMetadata` always *sets* `name`,
/// `context_window` and `billing` — possibly to `undefined` — which is why
/// [`enrich_open_code_models`] applies `??` to the fields rather than to the
/// record.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct OpenCodeModelMetadata {
    /// `name?: string`.
    pub name: Option<String>,
    /// `context_window?: number`.
    pub context_window: Option<f64>,
    /// `billing?: 'free' | 'paid'`.
    pub billing: Option<ModelBilling>,
}

/// `FALLBACK_METADATA[model.id]` from `metadata.ts:84`.
pub fn fallback_metadata(model_id: &str) -> Option<OpenCodeModelMetadata> {
    FALLBACK_METADATA
        .iter()
        .find(|(id, _name, _billing)| *id == model_id)
        .map(|(_id, name, billing)| OpenCodeModelMetadata {
            name: Some((*name).to_string()),
            context_window: None,
            billing: Some(*billing),
        })
}

/// `typeof value === 'object'` from `metadata.ts:17-19`.
///
/// `null` was already excluded by the caller's `value !== null`, and JavaScript's
/// `typeof` reports arrays as objects, so both JSON objects and arrays qualify.
fn as_record(value: &Value) -> Option<&Value> {
    match value {
        Value::Object(_) | Value::Array(_) => Some(value),
        _ => None,
    }
}

/// `asRecord(value)` for an optional field read (`metadata.ts:44`, `:67-68`).
fn record_of(value: Option<&Value>) -> Option<&Value> {
    value.and_then(as_record)
}

/// `Object.values(cost)` from `metadata.ts:27`: object values, array elements.
fn js_object_values(value: &Value) -> Vec<&Value> {
    match value {
        Value::Object(entries) => entries.values().collect(),
        Value::Array(entries) => entries.iter().collect(),
        _ => Vec::new(),
    }
}

/// `Object.entries(models)` from `metadata.ts:71`: object keys, array indices as
/// strings (`"0"`, `"1"`, …), matching `Object.keys` on an array.
fn js_object_entries(value: &Value) -> Vec<(String, &Value)> {
    match value {
        Value::Object(entries) => entries
            .iter()
            .map(|(key, value)| (key.clone(), value))
            .collect(),
        Value::Array(entries) => entries
            .iter()
            .enumerate()
            .map(|(index, value)| (index.to_string(), value))
            .collect(),
        _ => Vec::new(),
    }
}

/// `parseBilling` from `metadata.ts:21-33`.
///
/// Both `cost.input` and `cost.output` must be numbers before any element is
/// inspected; the classification then only looks at the *finite numeric* values
/// of the whole record.
///
/// The `if (directCosts.length === 0) return undefined` branch of
/// `metadata.ts:31` is kept for fidelity but is unreachable for an object: once
/// `input` and `output` are numbers they are themselves members of
/// `Object.values(cost)`. An array `cost` cannot reach it either, because arrays
/// have no `input`/`output` keys — the guard of line 23 rejects them first.
fn parse_billing(cost: &Value) -> Option<ModelBilling> {
    if cost.get("input").and_then(Value::as_f64).is_none()
        || cost.get("output").and_then(Value::as_f64).is_none()
    {
        return None;
    }

    let direct_costs: Vec<f64> = js_object_values(cost)
        .into_iter()
        .filter_map(Value::as_f64)
        .filter(|entry| entry.is_finite())
        .collect();

    if direct_costs.is_empty() {
        return None;
    }
    Some(if direct_costs.iter().all(|entry| *entry == 0.0) {
        ModelBilling::Free
    } else {
        ModelBilling::Paid
    })
}

/// `/\s+\(Unlimited\)$/i` from `metadata.ts:37`.
static UNLIMITED_SUFFIX_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\s+\(Unlimited\)$").expect("static regex is valid"));

/// `normalizeDisplayName` from `metadata.ts:35-38`.
///
/// A non-string or whitespace-only value is `undefined`; otherwise the
/// `(Unlimited)` marker is stripped and the result trimmed.
fn normalize_display_name(value: Option<&Value>) -> Option<String> {
    let text = value?.as_str()?;
    if text.trim().is_empty() {
        return None;
    }
    Some(UNLIMITED_SUFFIX_REGEX.replace(text, "").trim().to_string())
}

/// `parseMetadata` from `metadata.ts:40-55`.
///
/// A non-record argument reads as `{}` (`metadata.ts:42`), and the context window
/// comes from `model.limit.context` with the `Number.isFinite` guard of
/// `metadata.ts:49-52`.
fn parse_metadata(value: &Value) -> OpenCodeModelMetadata {
    let Some(model) = as_record(value) else {
        return OpenCodeModelMetadata::default();
    };

    let context_window = record_of(model.get("limit"))
        .and_then(|limit| limit.get("context"))
        .and_then(Value::as_f64)
        .filter(|context| context.is_finite());

    OpenCodeModelMetadata {
        name: normalize_display_name(model.get("name")),
        context_window,
        billing: record_of(model.get("cost")).and_then(parse_billing),
    }
}

/// `fetchOpenCodeModelMetadata` from `metadata.ts:57-76`.
///
/// GETs `https://models.dev/api.json` with `Accept: application/json` and the
/// shared 15 s default timeout — `metadata.ts:59-62` passes no third argument to
/// `fetchWithTimeout` — and never fails: a transport error, a non-2xx status and
/// an undecodable body all yield an empty map.
pub async fn fetch_open_code_model_metadata(
    transport: &dyn HttpTransport,
) -> BTreeMap<String, OpenCodeModelMetadata> {
    let request = HttpRequest::get(MODELS_DEV_API_URL).header("Accept", "application/json");
    let Ok(response) = fetch_with_timeout(transport, request).await else {
        return BTreeMap::new();
    };
    if !response.is_ok() {
        return BTreeMap::new();
    }
    let Ok(payload) = serde_json::from_str::<Value>(&response.body) else {
        return BTreeMap::new();
    };

    // `asRecord(payload?.opencode)`, then `asRecord(provider?.models)`.
    let provider = record_of(as_record(&payload).and_then(|payload| payload.get("opencode")));
    let Some(models) = record_of(provider.and_then(|provider| provider.get("models"))) else {
        return BTreeMap::new();
    };

    js_object_entries(models)
        .into_iter()
        .map(|(id, model)| (id, parse_metadata(model)))
        .collect()
}

/// `enrichOpenCodeModels` from `metadata.ts:78-96`.
///
/// The `??` chains are per field, not per record: a `providerMetadata` entry that
/// exists but carries `name: undefined` still lets the fallback table win. Note
/// that `billing` has no third link — the model's own value is *not* used
/// (`metadata.ts:93`).
///
/// The TypeScript spreads `...model` into a new object; the port mutates the list
/// it was given, which is observably the same since `fetchModels` owns it.
pub fn enrich_open_code_models(
    mut models: Vec<FetchedModel>,
    metadata: &BTreeMap<String, OpenCodeModelMetadata>,
) -> Vec<FetchedModel> {
    for model in &mut models {
        let provider_metadata = metadata.get(&model.id);
        let fallback = fallback_metadata(&model.id);

        let name = provider_metadata
            .and_then(|entry| entry.name.clone())
            .or_else(|| fallback.as_ref().and_then(|entry| entry.name.clone()))
            .unwrap_or_else(|| model.name.clone());
        let context_window = provider_metadata
            .and_then(|entry| entry.context_window)
            .or_else(|| fallback.as_ref().and_then(|entry| entry.context_window))
            .or(model.context_window);
        let billing = provider_metadata
            .and_then(|entry| entry.billing)
            .or_else(|| fallback.as_ref().and_then(|entry| entry.billing));

        model.name = name;
        model.context_window = context_window;
        model.billing = billing;
    }
    models
}

/// `openCodeProviderAdapter` from `opencode/index.ts:9-51`.
#[derive(Debug, Clone, Copy, Default)]
pub struct OpenCodeAdapter;

impl ProviderAdapter for OpenCodeAdapter {
    fn id(&self) -> &'static str {
        PROVIDER_ID
    }

    /// `opencode/index.ts:12-20`. The `apiBaseUrl` guard of line 13 resolves to an
    /// empty list instead of a rejected promise; an empty `/models` result skips
    /// the metadata call entirely (line 16).
    fn fetch_models<'a>(
        &'a self,
        context: &'a ProviderExecutionContext,
        call: &'a ProviderCall<'_>,
    ) -> BoxFuture<'a, Result<Vec<FetchedModel>, HttpError>> {
        Box::pin(async move {
            let Some(base_url) = context.provider.api_base_url.as_deref() else {
                return Ok(Vec::new());
            };

            let models = fetch_openai_compatible_models(
                call.transport,
                base_url,
                &context.secret,
                PROVIDER_ID,
            )
            .await?;
            if models.is_empty() {
                return Ok(models);
            }

            let metadata = fetch_open_code_model_metadata(call.transport).await;
            Ok(enrich_open_code_models(models, &metadata))
        })
    }

    /// `opencode/index.ts:22-33`: the shared models probe, but only when a base URL
    /// exists.
    fn test_connectivity<'a>(
        &'a self,
        context: &'a ProviderExecutionContext,
        call: &'a ProviderCall<'_>,
        _model: Option<&'a str>,
    ) -> BoxFuture<'a, ConnectivityResult> {
        Box::pin(async move {
            let Some(base_url) = context.provider.api_base_url.as_deref() else {
                return ConnectivityResult::failed(NO_BASE_URL_MESSAGE);
            };

            test_openai_compatible_models_endpoint(
                call.transport,
                base_url,
                &context.secret,
                CONNECTIVITY_OK,
                CONNECTIVITY_FAILURE_PREFIX,
            )
            .await
        })
    }

    /// `opencode/index.ts:35-50`. Without a base URL the adapter answers with a
    /// resolved failure `GatewayResponse` rather than an `Err`, which is why
    /// [`GatewayResponse::failure`] is used here and not an [`HttpError`].
    fn dispatch_gateway<'a>(
        &'a self,
        context: &'a ProviderExecutionContext,
        call: &'a ProviderCall<'_>,
        request: &'a GatewayRequest,
        options: &'a DispatchOptions,
    ) -> BoxFuture<'a, Result<GatewayResponse, HttpError>> {
        Box::pin(async move {
            let Some(base_url) = context.provider.api_base_url.as_deref() else {
                return Ok(GatewayResponse::failure(
                    request.model.clone(),
                    PROVIDER_ID,
                    NO_BASE_URL_MESSAGE,
                ));
            };

            dispatch_openai_compatible_chat(
                call.transport,
                call.attachments,
                base_url,
                &context.secret,
                self.id(),
                request,
                options,
            )
            .await
        })
    }
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::Mutex;

    use http::{HeaderMap, StatusCode};
    use serde_json::json;

    use super::*;
    use crate::model_hub::env::EnvOverrides;
    use crate::model_hub::http::{HttpResponse, UnreachableTransport};
    use crate::model_hub::openai_compatible::NOOP_ATTACHMENT_STORE;
    use crate::model_hub::provider_catalog::find_provider;
    use crate::model_hub::repository::encrypted_secret_input;
    use crate::model_hub::types::{GatewayMessage, ProviderAccountRecord, ProviderAuthMethod};

    /// Serves the scripted responses in order and keeps every request; a single
    /// scripted response answers forever.
    struct ScriptedTransport {
        responses: Mutex<VecDeque<HttpResponse>>,
        seen: Mutex<Vec<HttpRequest>>,
    }

    impl ScriptedTransport {
        fn new(responses: Vec<HttpResponse>) -> Self {
            Self {
                responses: Mutex::new(responses.into()),
                seen: Mutex::new(Vec::new()),
            }
        }

        fn single(response: HttpResponse) -> Self {
            Self::new(vec![response])
        }
    }

    impl HttpTransport for ScriptedTransport {
        fn send<'a>(
            &'a self,
            request: HttpRequest,
        ) -> BoxFuture<'a, Result<HttpResponse, HttpError>> {
            self.seen
                .lock()
                .expect("the request log is never poisoned")
                .push(request);
            let mut responses = self.responses.lock().expect("the script is never poisoned");
            let response = if responses.len() > 1 {
                responses.pop_front()
            } else {
                responses.front().cloned()
            };
            Box::pin(async move {
                response.ok_or_else(|| HttpError::Transport("the script ran dry".to_string()))
            })
        }
    }

    fn json_response(status: StatusCode, body: &str) -> HttpResponse {
        let mut headers = HeaderMap::new();
        headers.insert(
            http::header::CONTENT_TYPE,
            http::HeaderValue::from_static("application/json"),
        );
        HttpResponse::new(status, headers, body)
    }

    fn call<'a>(transport: &'a ScriptedTransport, env: &'a EnvOverrides) -> ProviderCall<'a> {
        ProviderCall {
            transport,
            attachments: &NOOP_ATTACHMENT_STORE,
            env,
        }
    }

    /// A context whose `apiBaseUrl` is pinned; `None` models a catalog entry
    /// without the optional field (`opencode/index.ts:13`).
    fn context(secret: &str, api_base_url: Option<&str>) -> ProviderExecutionContext {
        let mut provider = find_provider(PROVIDER_ID)
            .expect("opencode is in the catalog")
            .clone();
        provider.api_base_url = api_base_url.map(str::to_string);

        ProviderExecutionContext {
            provider,
            account: ProviderAccountRecord {
                id: "acc-opencode".to_string(),
                provider_id: PROVIDER_ID.to_string(),
                label: "opencode".to_string(),
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

    fn model(id: &str) -> FetchedModel {
        FetchedModel {
            id: id.to_string(),
            name: id.to_string(),
            provider: PROVIDER_ID.to_string(),
            owned_by: None,
            context_window: None,
            created: None,
            billing: None,
        }
    }

    /// The catalog value the adapter posts to.
    const BASE_URL: &str = "https://opencode.ai/zen/v1";

    /// `parseBilling` (`metadata.ts:21-33`): all-zero direct costs are free, any
    /// other finite number is paid, and a missing numeric `input`/`output` pair or
    /// an empty numeric view is `undefined`.
    #[test]
    fn billing_classification_matches_the_typescript_rules() {
        assert_eq!(
            parse_billing(&json!({ "input": 0, "output": 0 })),
            Some(ModelBilling::Free)
        );
        assert_eq!(
            parse_billing(&json!({ "input": 0, "output": 0.5, "cache_read": 0 })),
            Some(ModelBilling::Paid)
        );
        assert_eq!(
            parse_billing(&json!({ "input": 1, "output": 2, "cache_write": -1 })),
            Some(ModelBilling::Paid)
        );
        // Missing or non-numeric input/output.
        assert_eq!(parse_billing(&json!({ "input": 0 })), None);
        assert_eq!(parse_billing(&json!({ "input": "0", "output": 0 })), None);
        assert_eq!(parse_billing(&json!({ "input": null, "output": 0 })), None);
        // No numeric values at all → the array `[0, 0]` still wins, so the
        // `directCosts.length === 0` branch needs a cost without `input`/`output`.
        assert_eq!(
            parse_billing(&json!({ "input": 0, "output": 0, "currency": "USD" })),
            Some(ModelBilling::Free)
        );
        assert_eq!(
            parse_billing(&json!({ "input": 0, "output": "0", "other": 1 })),
            None
        );
    }

    /// `Object.values` also reads an array, so an array `cost` is billed by its
    /// elements (`metadata.ts:17-19`, `:27`).
    #[test]
    fn an_array_cost_is_billed_by_its_elements() {
        assert_eq!(parse_billing(&json!([0, 0])), None, "no input/output keys");
        assert_eq!(
            parse_billing(&json!({ "input": 0, "output": 0, "0": 3 })),
            Some(ModelBilling::Paid)
        );
    }

    /// `normalizeDisplayName` (`metadata.ts:35-38`).
    #[test]
    fn display_names_lose_the_unlimited_marker() {
        assert_eq!(
            normalize_display_name(Some(&json!("Ox Alpha (Unlimited)"))),
            Some("Ox Alpha".to_string())
        );
        assert_eq!(
            normalize_display_name(Some(&json!("ox (UNLIMITED)"))),
            Some("ox".to_string())
        );
        assert_eq!(
            normalize_display_name(Some(&json!("  spaced  "))),
            Some("spaced".to_string())
        );
        // The suffix needs at least one whitespace character before it.
        assert_eq!(
            normalize_display_name(Some(&json!("Model(Unlimited)"))),
            Some("Model(Unlimited)".to_string())
        );
        // A lone marker trims down to the empty string, exactly like `.trim()`.
        assert_eq!(
            normalize_display_name(Some(&json!(" (Unlimited)"))),
            Some(String::new())
        );
        assert_eq!(normalize_display_name(Some(&json!("   "))), None);
        assert_eq!(normalize_display_name(Some(&json!(7))), None);
        assert_eq!(normalize_display_name(None), None);
    }

    /// `parseMetadata` (`metadata.ts:40-55`) reads `name`, `limit.context` and
    /// `cost`, and treats a non-record as `{}`.
    #[test]
    fn metadata_reads_name_context_window_and_billing() {
        let parsed = parse_metadata(&json!({
            "name": "Zen Model (Unlimited)",
            "limit": { "context": 128000, "output": 8192 },
            "cost": { "input": 0, "output": 0 }
        }));
        assert_eq!(
            parsed,
            OpenCodeModelMetadata {
                name: Some("Zen Model".to_string()),
                context_window: Some(128_000.0),
                billing: Some(ModelBilling::Free),
            }
        );

        // A string `limit.context` and a missing `limit` are both undefined.
        assert_eq!(
            parse_metadata(&json!({ "limit": { "context": "128000" } })),
            OpenCodeModelMetadata::default()
        );
        assert_eq!(
            parse_metadata(&json!({ "name": 12 })),
            OpenCodeModelMetadata::default()
        );
        assert_eq!(
            parse_metadata(&json!(null)),
            OpenCodeModelMetadata::default()
        );
        assert_eq!(
            parse_metadata(&json!("not-a-model")),
            OpenCodeModelMetadata::default()
        );
    }

    /// The models.dev request is a plain GET with `Accept: application/json` and
    /// the shared 15 s default (`metadata.ts:59-62`).
    #[tokio::test]
    async fn metadata_request_uses_models_dev_with_the_default_timeout() {
        let transport = ScriptedTransport::single(json_response(
            StatusCode::OK,
            r#"{"opencode":{"models":{"big-pickle":{"name":"Big Pickle"}}}}"#,
        ));
        let metadata = fetch_open_code_model_metadata(&transport).await;

        assert_eq!(
            metadata.get("big-pickle"),
            Some(&OpenCodeModelMetadata {
                name: Some("Big Pickle".to_string()),
                context_window: None,
                billing: None,
            })
        );
        let seen = transport.seen.lock().expect("lock");
        assert_eq!(seen[0].url, "https://models.dev/api.json");
        assert_eq!(seen[0].method, http::Method::GET);
        assert_eq!(
            seen[0].headers.get("accept").expect("accept"),
            "application/json"
        );
        assert_eq!(
            seen[0].timeout_ms,
            crate::model_hub::http::DEFAULT_REQUEST_TIMEOUT_MS
        );
        assert!(seen[0].headers.get("authorization").is_none());
    }

    /// A non-2xx status, an undecodable body, a missing `opencode` key and a
    /// transport failure all yield an empty map (`metadata.ts:64-74`).
    #[tokio::test]
    async fn metadata_failures_yield_an_empty_map() {
        for body in [
            r#"{"opencode":{"models":{}}}"#,
            r#"{"other":{"models":{}}}"#,
            r#"{"opencode":{}}"#,
            r#"{"opencode":"nope"}"#,
        ] {
            let transport = ScriptedTransport::single(json_response(StatusCode::OK, body));
            assert!(
                fetch_open_code_model_metadata(&transport).await.is_empty(),
                "{body}"
            );
        }

        let transport =
            ScriptedTransport::single(json_response(StatusCode::OK, "<html>nope</html>"));
        assert!(fetch_open_code_model_metadata(&transport).await.is_empty());

        let transport = ScriptedTransport::single(json_response(StatusCode::NOT_FOUND, "{}"));
        assert!(fetch_open_code_model_metadata(&transport).await.is_empty());

        assert!(fetch_open_code_model_metadata(&UnreachableTransport)
            .await
            .is_empty());
    }

    /// A `models` object keyed by id, or an array whose indices become the keys
    /// (`metadata.ts:68-71`).
    #[tokio::test]
    async fn metadata_accepts_an_array_models_map() {
        let transport = ScriptedTransport::single(json_response(
            StatusCode::OK,
            r#"{"opencode":{"models":[{"name":"Entry Zero"},{"name":"Entry One"}]}}"#,
        ));
        let metadata = fetch_open_code_model_metadata(&transport).await;
        assert_eq!(
            metadata.get("0").and_then(|entry| entry.name.clone()),
            Some("Entry Zero".to_string())
        );
        assert_eq!(
            metadata.get("1").and_then(|entry| entry.name.clone()),
            Some("Entry One".to_string())
        );
    }

    /// `providerMetadata` wins over the fallback table and over the model's own
    /// values (`metadata.ts:86-94`).
    #[test]
    fn provider_metadata_wins_over_the_fallback_table() {
        let mut metadata = BTreeMap::new();
        metadata.insert(
            "ox-alpha-free".to_string(),
            OpenCodeModelMetadata {
                name: Some("Live Name".to_string()),
                context_window: Some(200_000.0),
                billing: Some(ModelBilling::Paid),
            },
        );

        let enriched = enrich_open_code_models(vec![model("ox-alpha-free")], &metadata);
        assert_eq!(enriched[0].name, "Live Name");
        assert_eq!(enriched[0].context_window, Some(200_000.0));
        assert_eq!(enriched[0].billing, Some(ModelBilling::Paid));
        assert_eq!(enriched[0].provider, PROVIDER_ID);
    }

    /// The built-in table names the two ids models.dev does not describe, and it
    /// carries no context window (`metadata.ts:12-15`).
    #[test]
    fn the_fallback_table_names_the_two_known_ids() {
        let enriched = enrich_open_code_models(
            vec![model("ox-alpha-free"), model("x-preview-f-free")],
            &BTreeMap::new(),
        );
        assert_eq!(enriched[0].name, "Ox Alpha Free");
        assert_eq!(enriched[0].billing, Some(ModelBilling::Free));
        assert_eq!(enriched[0].context_window, None);
        assert_eq!(enriched[1].name, "Ox Alpha Free");

        assert_eq!(fallback_metadata("unknown-id"), None);
    }

    /// `??` falls through per field: the metadata entry exists but leaves `name`
    /// and `context_window` unset, so the model keeps its own values.
    #[test]
    fn unset_metadata_fields_fall_back_to_the_model() {
        let mut metadata = BTreeMap::new();
        metadata.insert("big-pickle".to_string(), OpenCodeModelMetadata::default());

        let mut existing = model("big-pickle");
        existing.name = "Big Pickle".to_string();
        existing.context_window = Some(32_000.0);

        let enriched = enrich_open_code_models(vec![existing], &metadata);
        assert_eq!(enriched[0].name, "Big Pickle");
        assert_eq!(enriched[0].context_window, Some(32_000.0));
        // `billing` has no third link, so a missing entry clears the model value.
        assert_eq!(enriched[0].billing, None);
    }

    /// The billing column of the source record is authoritative even when the
    /// model arrived with its own tag (`metadata.ts:93`).
    #[test]
    fn billing_is_not_inherited_from_the_model() {
        let mut existing = model("big-pickle");
        existing.billing = Some(ModelBilling::Paid);

        let enriched = enrich_open_code_models(vec![existing], &BTreeMap::new());
        assert_eq!(enriched[0].billing, None);

        let mut metadata = BTreeMap::new();
        metadata.insert(
            "big-pickle".to_string(),
            OpenCodeModelMetadata {
                billing: Some(ModelBilling::Free),
                ..OpenCodeModelMetadata::default()
            },
        );
        let mut existing = model("big-pickle");
        existing.billing = Some(ModelBilling::Paid);
        let enriched = enrich_open_code_models(vec![existing], &metadata);
        assert_eq!(enriched[0].billing, Some(ModelBilling::Free));
    }

    /// `if (!provider.apiBaseUrl) return Promise.resolve([])`
    /// (`opencode/index.ts:13`): no request is issued at all.
    #[tokio::test]
    async fn fetch_models_without_a_base_url_returns_an_empty_list() {
        let transport = ScriptedTransport::single(json_response(StatusCode::OK, r#"{"data":[]}"#));
        let env = EnvOverrides::new();
        let models = OpenCodeAdapter
            .fetch_models(&context("sk", None), &call(&transport, &env))
            .await
            .expect("fetch");
        assert!(models.is_empty());
        assert!(transport.seen.lock().expect("lock").is_empty());
    }

    /// The happy path: `/models` first, then the models.dev enrichment
    /// (`opencode/index.ts:15-19`).
    #[tokio::test]
    async fn fetch_models_enriches_the_shared_models_list() {
        let transport = ScriptedTransport::new(vec![
            json_response(
                StatusCode::OK,
                r#"{"data":[{"id":"big-pickle","owned_by":"opencode","created":1700000000}]}"#,
            ),
            json_response(
                StatusCode::OK,
                r#"{"opencode":{"models":{"big-pickle":{"name":"Big Pickle (Unlimited)","limit":{"context":256000},"cost":{"input":0,"output":0}}}}}"#,
            ),
        ]);
        let env = EnvOverrides::new();
        let models = OpenCodeAdapter
            .fetch_models(
                &context("sk-opencode", Some(BASE_URL)),
                &call(&transport, &env),
            )
            .await
            .expect("fetch");

        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "big-pickle");
        assert_eq!(models[0].name, "Big Pickle");
        assert_eq!(models[0].context_window, Some(256_000.0));
        assert_eq!(models[0].billing, Some(ModelBilling::Free));
        assert_eq!(models[0].owned_by.as_deref(), Some("opencode"));

        let seen = transport.seen.lock().expect("lock");
        assert_eq!(seen.len(), 2);
        assert_eq!(seen[0].url, "https://opencode.ai/zen/v1/models");
        assert_eq!(
            seen[0].headers.get("authorization").expect("auth"),
            "Bearer sk-opencode"
        );
        assert_eq!(seen[1].url, "https://models.dev/api.json");
    }

    /// `if (models.length === 0) return models` (`opencode/index.ts:16`): a
    /// non-2xx `/models` response skips the metadata call.
    #[tokio::test]
    async fn an_empty_models_list_skips_the_metadata_call() {
        let transport = ScriptedTransport::new(vec![
            json_response(StatusCode::FORBIDDEN, "denied"),
            json_response(StatusCode::OK, r#"{"opencode":{"models":{}}}"#),
        ]);
        let env = EnvOverrides::new();
        let models = OpenCodeAdapter
            .fetch_models(&context("sk", Some(BASE_URL)), &call(&transport, &env))
            .await
            .expect("fetch");
        assert!(models.is_empty());
        assert_eq!(transport.seen.lock().expect("lock").len(), 1);
    }

    /// A transport failure of `/models` propagates: `fetchModels` has no
    /// `.catch` here (`opencode/index.ts:15`).
    #[tokio::test]
    async fn a_transport_failure_propagates_out_of_fetch_models() {
        let env = EnvOverrides::new();
        let call = ProviderCall {
            transport: &UnreachableTransport,
            attachments: &NOOP_ATTACHMENT_STORE,
            env: &env,
        };
        let error = OpenCodeAdapter
            .fetch_models(&context("sk", Some(BASE_URL)), &call)
            .await
            .expect_err("transport failure");
        assert_eq!(
            error,
            HttpError::Transport("No HTTP transport is configured.".to_string())
        );
    }

    /// The metadata call never fails the fetch, even when models.dev is down.
    #[tokio::test]
    async fn a_metadata_failure_still_returns_the_live_models() {
        let transport = ScriptedTransport::new(vec![
            json_response(StatusCode::OK, r#"{"data":[{"id":"big-pickle"}]}"#),
            json_response(StatusCode::BAD_GATEWAY, "upstream died"),
        ]);
        let env = EnvOverrides::new();
        let models = OpenCodeAdapter
            .fetch_models(&context("sk", Some(BASE_URL)), &call(&transport, &env))
            .await
            .expect("fetch");
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "big-pickle");
        assert_eq!(models[0].name, "big-pickle");
    }

    /// The catalog entry is the source of the base URL, and it is the one the port
    /// posts to.
    #[test]
    fn the_catalog_supplies_the_base_url() {
        let provider = find_provider(PROVIDER_ID).expect("catalog");
        assert_eq!(provider.api_base_url.as_deref(), Some(BASE_URL));
        assert_eq!(provider.default_models.len(), 4);
    }

    /// `opencode/index.ts:23-25`: without a base URL the probe never fires.
    #[tokio::test]
    async fn connectivity_without_a_base_url_reports_the_missing_url() {
        let transport = ScriptedTransport::single(json_response(StatusCode::OK, r#"{"data":[]}"#));
        let env = EnvOverrides::new();
        let result = OpenCodeAdapter
            .test_connectivity(&context("sk", None), &call(&transport, &env), None)
            .await;
        assert!(!result.ok);
        assert_eq!(result.message, NO_BASE_URL_MESSAGE);
        assert!(transport.seen.lock().expect("lock").is_empty());
    }

    /// The shared probe's two messages (`opencode/index.ts:27-32`).
    #[tokio::test]
    async fn connectivity_uses_the_shared_messages() {
        let transport = ScriptedTransport::single(json_response(StatusCode::OK, r#"{"data":[]}"#));
        let env = EnvOverrides::new();
        let result = OpenCodeAdapter
            .test_connectivity(
                &context("sk", Some(BASE_URL)),
                &call(&transport, &env),
                None,
            )
            .await;
        assert!(result.ok);
        assert_eq!(result.message, CONNECTIVITY_OK);

        let transport =
            ScriptedTransport::single(json_response(StatusCode::UNAUTHORIZED, "bad key"));
        let result = OpenCodeAdapter
            .test_connectivity(
                &context("sk", Some(BASE_URL)),
                &call(&transport, &env),
                None,
            )
            .await;
        assert!(!result.ok);
        assert_eq!(
            result.message, "OpenCode connectivity failed: bad key",
            "the shared helper adds no separator"
        );
    }

    /// `opencode/index.ts:36-44`: the missing base URL becomes a resolved failure
    /// response that still carries the requested model.
    #[tokio::test]
    async fn dispatch_without_a_base_url_returns_a_failure_response() {
        let transport = ScriptedTransport::single(json_response(StatusCode::OK, r#"{"data":[]}"#));
        let env = EnvOverrides::new();
        let request = GatewayRequest::new("big-pickle", vec![GatewayMessage::user("hi")]);
        let response = OpenCodeAdapter
            .dispatch_gateway(
                &context("sk", None),
                &call(&transport, &env),
                &request,
                &DispatchOptions::default(),
            )
            .await
            .expect("dispatch");

        assert!(!response.ok);
        assert_eq!(response.text, "");
        assert_eq!(response.model, "big-pickle");
        assert_eq!(response.provider, PROVIDER_ID);
        assert_eq!(response.error.as_deref(), Some(NO_BASE_URL_MESSAGE));
        assert_eq!(response.usage, None);
        assert_eq!(response.function_calls, None);
        assert_eq!(response.rate_limits, None);
        assert!(transport.seen.lock().expect("lock").is_empty());
    }

    /// `opencode/index.ts:46-49`: the shared chat call against `apiBaseUrl`.
    #[tokio::test]
    async fn dispatch_posts_to_the_catalog_base_url() {
        let transport = ScriptedTransport::single(json_response(
            StatusCode::OK,
            r#"{"choices":[{"message":{"content":"ok"}}],"model":"big-pickle"}"#,
        ));
        let env = EnvOverrides::new();
        let response = OpenCodeAdapter
            .dispatch_gateway(
                &context("sk-opencode", Some(BASE_URL)),
                &call(&transport, &env),
                &GatewayRequest::new("big-pickle", vec![GatewayMessage::user("hi")]),
                &DispatchOptions::default(),
            )
            .await
            .expect("dispatch");

        assert!(response.ok);
        assert_eq!(response.provider, PROVIDER_ID);
        let seen = transport.seen.lock().expect("lock");
        assert_eq!(seen[0].url, "https://opencode.ai/zen/v1/chat/completions");
        assert_eq!(
            seen[0].body.as_deref().expect("body"),
            r#"{"model":"big-pickle","messages":[{"role":"user","content":"hi"}],"max_tokens":4096,"temperature":0.7,"stream":false}"#
        );
    }
}
