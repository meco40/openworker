//! Port of `src/server/model-hub/Models/ollama/index.ts`.
//!
//! | Rust | TypeScript |
//! | --- | --- |
//! | [`DEFAULT_BASE_URL`] | `'http://localhost:11434'` (`ollama/index.ts:6`) |
//! | [`base_url`] | `ollamaBaseUrl` (`ollama/index.ts:5-7`) |
//! | [`map_default_models`] | `mapDefaultModels` (`ollama/index.ts:9-15`) |
//! | [`merge_unique_models`] | `mergeUniqueModels` (`ollama/index.ts:17-26`) |
//! | [`fetch_ollama_tags`] | `fetchOllamaTags` (`ollama/index.ts:28-55`) |
//! | [`OllamaAdapter`] | `ollamaProviderAdapter` (`ollama/index.ts:57-84`) |
//! | [`TAGS_TIMEOUT_MS`] | the `20_000` literal of `ollama/index.ts:40` |
//! | [`CONNECTIVITY_OK`] | `ollama/index.ts:70` |
//! | [`CONNECTIVITY_NO_MODELS`] | `ollama/index.ts:71` |
//! | [`CONNECTIVITY_FAILURE_PREFIX`] | `ollama/index.ts:75` |
//! | [`CONNECTIVITY_FALLBACK_MESSAGE`] | `'request failed'`, `ollama/index.ts:76` |
//!
//! The catalog lists Ollama as `openai-compatible` with
//! `apiBaseUrl = 'http://localhost:11434/v1'` (`providerCatalog.ts`), but the
//! adapter does **not** read that field: every URL is derived from
//! `OLLAMA_BASE_URL`, defaulting to the bare origin `http://localhost:11434`
//! (`ollama/index.ts:6`). The tags probe therefore targets `/api/tags` on the
//! origin while the chat call targets `/v1/chat/completions` under it — the `/v1`
//! is appended literally at `ollama/index.ts:80`, and `buildChatUrl`'s own
//! `normalizeBaseUrl` has nothing left to strip.
//!
//! `OLLAMA_BASE_URL` has a second reader, `service/dispatch/embedding.ts:96`,
//! which is why `env.rs` lists it; the port reads the variable at call time
//! through [`ProviderCall::env`], exactly like `process.env`.
//!
//! # Deviations from the TypeScript
//!
//! - **Raw `trim` instead of `normalizeBearerSecret`.** `fetchOllamaTags`
//!   authorises with `` `Bearer ${secret.trim()}` `` (`ollama/index.ts:29-32`) and
//!   never calls the shared `normalizeBearerSecret` (`utils.ts:5-13`) that
//!   [`crate::model_hub::openai_compatible::utils::build_optional_auth_headers`]
//!   applies for `/models` and for the chat request. A secret wrapped in quotes
//!   or prefixed with `Bearer ` is therefore sent verbatim to `/api/tags` but
//!   normalised for `/v1/chat/completions`. Ported as-is; [`secret_header`] is the
//!   raw form and the shared helper is untouched.
//! - **`String(value)` coercion.** `ollama/index.ts:48` is
//!   `String(model.model || model.name || '')`. [`tag_model_id`] reproduces the
//!   `||` chain and the `String()` coercion for strings and JSON numbers; a JSON
//!   `true`, object or array — which `/api/tags` never sends — is treated as
//!   absent instead of becoming `"true"`/`"[object Object]"`.
//! - **`String.prototype.trim`.** `ollama/index.ts:48` trims with JavaScript's
//!   whitespace set, which includes U+FEFF; Rust's [`str::trim`] trims the Unicode
//!   `White_Space` set, which does not. Only a BOM-padded tag name could tell the
//!   two apart.
//! - **`payload.models` that is not an array.** `(payload.models || []).map(…)`
//!   throws a `TypeError` for a non-array truthy `models`, which `fetchModels`
//!   swallows through `.catch(() => [])` but which `testConnectivity` reports as
//!   `Ollama connectivity failed: <TypeError text>`. The port reads a non-array as
//!   "no models" — the same choice [`crate::model_hub::service::embedding`]
//!   documents for `json.data`.
//! - **`error.message`.** The catch at `ollama/index.ts:73-78` reports the
//!   `Error.message` of a rejected `fetch`/`response.json()`. The port reports
//!   [`HttpError`]'s `Display`, which is the Node text for the timeout abort and
//!   the client's message for a transport failure, while a JSON `SyntaxError` is
//!   rendered as `invalid response body: <serde_json error>`. `'request failed'`
//!   is only reachable in TypeScript when something other than an `Error` is
//!   thrown, which cannot happen for a `fetch` rejection; the constant is kept for
//!   traceability and is therefore never produced.
//!
//! # SDK usage in the TypeScript
//!
//! None. `ollama/index.ts` uses the global `fetch` through `fetchWithTimeout` and
//! `dispatchOpenAICompatibleChat`, so this port is REST against the injected
//! [`HttpTransport`] with no SDK translation.

use serde_json::Value;

use crate::model_hub::env::EnvOverrides;
use crate::model_hub::http::{
    fetch_with_timeout, BoxFuture, HttpError, HttpRequest, HttpTransport,
};
use crate::model_hub::openai_compatible::{
    dispatch_openai_compatible_chat, normalize_base_url, DispatchOptions,
};
use crate::model_hub::types::{
    ConnectivityResult, FetchedModel, GatewayRequest, GatewayResponse, ProviderExecutionContext,
};

use super::{ProviderAdapter, ProviderCall};

/// `'http://localhost:11434'` from `ollama/index.ts:6`.
pub const DEFAULT_BASE_URL: &str = "http://localhost:11434";
/// `'ollama'` — the adapter id and the `provider` field of every mapped model.
pub const PROVIDER_ID: &str = "ollama";
/// The `20_000` timeout of `ollama/index.ts:40`, passed positionally to
/// `fetchWithTimeout`.
pub const TAGS_TIMEOUT_MS: u64 = 20_000;
/// `'Ollama connectivity verified.'` from `ollama/index.ts:70`.
pub const CONNECTIVITY_OK: &str = "Ollama connectivity verified.";
/// `'Ollama connectivity failed: no local models returned by /api/tags.'` from
/// `ollama/index.ts:71`.
pub const CONNECTIVITY_NO_MODELS: &str =
    "Ollama connectivity failed: no local models returned by /api/tags.";
/// `'Ollama connectivity failed: '` from `ollama/index.ts:75`.
pub const CONNECTIVITY_FAILURE_PREFIX: &str = "Ollama connectivity failed: ";
/// `'request failed'` from `ollama/index.ts:76` — the `error instanceof Error`
/// fallback. See the module note: unreachable behind [`HttpError`].
pub const CONNECTIVITY_FALLBACK_MESSAGE: &str = "request failed";
/// `'/v1'` — appended to the origin by `ollama/index.ts:80`.
pub const OPENAI_COMPATIBLE_SUFFIX: &str = "/v1";

/// `ollamaBaseUrl` from `ollama/index.ts:5-7`:
/// `(process.env.OLLAMA_BASE_URL || 'http://localhost:11434').replace(/\/$/, '')`.
pub fn base_url(env: &EnvOverrides) -> String {
    normalize_base_url(&env.get_or("OLLAMA_BASE_URL", DEFAULT_BASE_URL))
}

/// `mapDefaultModels` from `ollama/index.ts:9-15`.
pub fn map_default_models(default_models: &[String]) -> Vec<FetchedModel> {
    default_models
        .iter()
        .map(|id| FetchedModel {
            id: id.clone(),
            name: id.clone(),
            provider: PROVIDER_ID.to_string(),
            owned_by: None,
            context_window: None,
            created: None,
            billing: None,
        })
        .collect()
}

/// `mergeUniqueModels` from `ollama/index.ts:17-26`: the first list wins and a
/// falsy id is skipped, which in Rust is the empty string a tag without
/// `model`/`name` produces.
///
/// Deliberately a second copy of `kimi::merge_unique_models` rather than an
/// import: `ollama/index.ts:17-26` and `kimi/index.ts:18-27` are separate
/// functions in the source, so a reviewer diffs each file against its own TS
/// module.
pub fn merge_unique_models(
    primary: Vec<FetchedModel>,
    secondary: Vec<FetchedModel>,
) -> Vec<FetchedModel> {
    let mut seen: Vec<String> = Vec::new();
    let mut merged: Vec<FetchedModel> = Vec::new();
    for model in primary.into_iter().chain(secondary) {
        if model.id.is_empty() || seen.contains(&model.id) {
            continue;
        }
        seen.push(model.id.clone());
        merged.push(model);
    }
    merged
}

/// `String(model.model || model.name || '')` from `ollama/index.ts:48`; the
/// `.filter(Boolean)` of line 49 is applied by [`models_from_tags`].
///
/// [`str::trim`] stands in for `String.prototype.trim` (see the module note).
/// `Value::get` returns `None` for a scalar entry, so a tag that is not an object
/// yields the empty string and is filtered out, exactly like the `undefined`
/// property read in JavaScript.
fn tag_model_id(entry: &Value) -> String {
    for key in ["model", "name"] {
        match entry.get(key) {
            Some(Value::String(text)) => return text.trim().to_string(),
            Some(Value::Number(number)) => return number.to_string(),
            _ => {}
        }
    }
    String::new()
}

/// `(payload.models || []).map(…).filter(Boolean).map(…)` from
/// `ollama/index.ts:47-54`.
fn models_from_tags(payload: &Value) -> Vec<FetchedModel> {
    payload
        .get("models")
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .map(tag_model_id)
                .filter(|id| !id.is_empty())
                .map(|id| FetchedModel {
                    id: id.clone(),
                    name: id,
                    provider: PROVIDER_ID.to_string(),
                    owned_by: None,
                    context_window: None,
                    created: None,
                    billing: None,
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The `headers` object of `ollama/index.ts:29-32`:
/// `if (secret.trim()) headers.Authorization = \`Bearer ${secret.trim()}\``.
fn secret_header(secret: &str) -> Option<String> {
    let trimmed = secret.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(format!("Bearer {trimmed}"))
    }
}

/// `fetchOllamaTags` from `ollama/index.ts:28-55`.
///
/// GETs `${ollamaBaseUrl()}/api/tags` with a 20 s timeout, returns `[]` for a
/// non-2xx status (line 42) and maps `payload.models` otherwise. A transport
/// failure and an undecodable body *do* propagate as [`HttpError`]; the two
/// callers decide what to do with them (`.catch(() => [])` in `fetchModels`, the
/// catch block in `testConnectivity`).
pub async fn fetch_ollama_tags(
    transport: &dyn HttpTransport,
    env: &EnvOverrides,
    secret: &str,
) -> Result<Vec<FetchedModel>, HttpError> {
    let mut request =
        HttpRequest::get(format!("{}/api/tags", base_url(env))).timeout_ms(TAGS_TIMEOUT_MS);
    if let Some(authorization) = secret_header(secret) {
        request = request.header("Authorization", &authorization);
    }

    let response = fetch_with_timeout(transport, request).await?;
    if !response.is_ok() {
        return Ok(Vec::new());
    }

    let payload: Value = serde_json::from_str(&response.body)
        .map_err(|error| HttpError::InvalidBody(error.to_string()))?;
    Ok(models_from_tags(&payload))
}

/// `error instanceof Error ? error.message : 'request failed'`
/// (`ollama/index.ts:75-77`).
///
/// [`HttpError`] is always an error object, so the second branch is unreachable;
/// [`CONNECTIVITY_FALLBACK_MESSAGE`] documents that instead of hiding it.
fn error_message(error: &HttpError) -> String {
    let message = error.to_string();
    if message.is_empty() {
        CONNECTIVITY_FALLBACK_MESSAGE.to_string()
    } else {
        message
    }
}

/// `ollamaProviderAdapter` from `ollama/index.ts:57-84`.
#[derive(Debug, Clone, Copy, Default)]
pub struct OllamaAdapter;

impl ProviderAdapter for OllamaAdapter {
    fn id(&self) -> &'static str {
        PROVIDER_ID
    }

    /// `ollama/index.ts:59-63`: the remote tags come first, the catalog's
    /// `defaultModels` fill the gaps, and the `.catch(() => [])` plus the
    /// `defaultModels` fallback mean `fetchModels` never rejects.
    fn fetch_models<'a>(
        &'a self,
        context: &'a ProviderExecutionContext,
        call: &'a ProviderCall<'_>,
    ) -> BoxFuture<'a, Result<Vec<FetchedModel>, HttpError>> {
        Box::pin(async move {
            let remote = fetch_ollama_tags(call.transport, call.env, &context.secret)
                .await
                .unwrap_or_default();
            let fallback = map_default_models(&context.provider.default_models);
            Ok(merge_unique_models(remote, fallback))
        })
    }

    /// `ollama/index.ts:64-78`. Success requires at least one model: a reachable
    /// but empty Ollama reports the `/api/tags` message, not success.
    fn test_connectivity<'a>(
        &'a self,
        context: &'a ProviderExecutionContext,
        call: &'a ProviderCall<'_>,
        _model: Option<&'a str>,
    ) -> BoxFuture<'a, ConnectivityResult> {
        Box::pin(async move {
            match fetch_ollama_tags(call.transport, call.env, &context.secret).await {
                Ok(models) if models.is_empty() => {
                    ConnectivityResult::failed(CONNECTIVITY_NO_MODELS)
                }
                Ok(_) => ConnectivityResult::ok(CONNECTIVITY_OK),
                Err(error) => ConnectivityResult::failed(format!(
                    "{CONNECTIVITY_FAILURE_PREFIX}{}",
                    error_message(&error)
                )),
            }
        })
    }

    /// `ollama/index.ts:79-83`. The only local provider whose chat base URL
    /// carries the `/v1` suffix; `normalizeBaseUrl` inside the shared layer then
    /// has nothing to strip.
    fn dispatch_gateway<'a>(
        &'a self,
        context: &'a ProviderExecutionContext,
        call: &'a ProviderCall<'_>,
        request: &'a GatewayRequest,
        options: &'a DispatchOptions,
    ) -> BoxFuture<'a, Result<GatewayResponse, HttpError>> {
        Box::pin(async move {
            dispatch_openai_compatible_chat(
                call.transport,
                call.attachments,
                &format!("{}{OPENAI_COMPATIBLE_SUFFIX}", base_url(call.env)),
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

    use super::*;
    use crate::model_hub::http::{HttpResponse, UnreachableTransport};
    use crate::model_hub::openai_compatible::NOOP_ATTACHMENT_STORE;
    use crate::model_hub::provider_catalog::find_provider;
    use crate::model_hub::repository::encrypted_secret_input;
    use crate::model_hub::types::{GatewayMessage, ProviderAccountRecord, ProviderAuthMethod};

    /// Serves the scripted responses in order and keeps every request. With a
    /// single scripted response it answers that one forever.
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

    fn context(secret: &str) -> ProviderExecutionContext {
        ProviderExecutionContext {
            provider: find_provider(PROVIDER_ID)
                .expect("ollama is in the catalog")
                .clone(),
            account: ProviderAccountRecord {
                id: "acc-ollama".to_string(),
                provider_id: PROVIDER_ID.to_string(),
                label: "ollama".to_string(),
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

    /// The default base URL, pinned so the test does not depend on the ambient
    /// `OLLAMA_BASE_URL`.
    fn env() -> EnvOverrides {
        EnvOverrides::new().with("OLLAMA_BASE_URL", DEFAULT_BASE_URL)
    }

    fn ids(models: &[FetchedModel]) -> Vec<&str> {
        models.iter().map(|model| model.id.as_str()).collect()
    }

    /// `ollamaBaseUrl` strips exactly one trailing slash and defaults to the bare
    /// origin (`ollama/index.ts:6`).
    #[test]
    fn base_url_strips_one_trailing_slash_and_defaults_to_the_origin() {
        assert_eq!(base_url(&env()), "http://localhost:11434");
        assert_eq!(
            base_url(&EnvOverrides::new().with("OLLAMA_BASE_URL", "http://box:11434/")),
            "http://box:11434"
        );
        // Only one slash: `replace(/\/$/, '')` has no `g` flag.
        assert_eq!(
            base_url(&EnvOverrides::new().with("OLLAMA_BASE_URL", "http://box:11434//")),
            "http://box:11434/"
        );
        // `process.env.X || default` treats the empty string as absent.
        assert_eq!(
            base_url(&EnvOverrides::new().with("OLLAMA_BASE_URL", "")),
            DEFAULT_BASE_URL
        );
    }

    /// The probe is `GET ${base}/api/tags` with the 20 s timeout and
    /// `Bearer ${secret.trim()}` (`ollama/index.ts:29-41`).
    #[tokio::test]
    async fn tags_request_uses_the_origin_the_timeout_and_the_raw_secret() {
        let transport = ScriptedTransport::single(json_response(
            StatusCode::OK,
            r#"{"models":[{"name":"llama3.2"}]}"#,
        ));
        let models = fetch_ollama_tags(&transport, &env(), "  sk-ollama  ")
            .await
            .expect("tags");
        assert_eq!(ids(&models), vec!["llama3.2"]);

        let seen = transport.seen.lock().expect("lock");
        assert_eq!(seen[0].url, "http://localhost:11434/api/tags");
        assert_eq!(seen[0].method, http::Method::GET);
        assert_eq!(seen[0].timeout_ms, 20_000);
        assert_eq!(
            seen[0].headers.get("authorization").expect("auth"),
            "Bearer sk-ollama"
        );
    }

    /// No secret, no `Authorization` header (`ollama/index.ts:30`).
    #[tokio::test]
    async fn an_empty_secret_sends_no_authorization_header() {
        let transport =
            ScriptedTransport::single(json_response(StatusCode::OK, r#"{"models":[]}"#));
        fetch_ollama_tags(&transport, &env(), "   ")
            .await
            .expect("tags");
        let seen = transport.seen.lock().expect("lock");
        assert!(seen[0].headers.get("authorization").is_none());
    }

    /// `model.model` wins over `model.name`, both are trimmed, and empty or
    /// non-string values are dropped (`ollama/index.ts:47-49`).
    #[tokio::test]
    async fn tag_parsing_prefers_model_then_name_and_drops_empties() {
        let transport = ScriptedTransport::single(json_response(
            StatusCode::OK,
            r#"{"models":[
                {"model":"  qwen2.5-coder:7b  ","name":"ignored"},
                {"name":"llama3.2"},
                {"model":""},
                {"model":"   "},
                {},
                "not-an-object"
            ]}"#,
        ));
        let models = fetch_ollama_tags(&transport, &env(), "sk")
            .await
            .expect("tags");
        assert_eq!(ids(&models), vec!["qwen2.5-coder:7b", "llama3.2"]);
        assert_eq!(models[0].name, "qwen2.5-coder:7b");
        assert_eq!(models[0].provider, PROVIDER_ID);
        assert_eq!(models[0].owned_by, None);
        assert_eq!(models[0].context_window, None);
        assert_eq!(models[0].created, None);
    }

    /// A missing or non-array `models` reads as "no models" instead of throwing
    /// (`ollama/index.ts:44-47`).
    #[tokio::test]
    async fn a_missing_models_field_yields_an_empty_list() {
        for body in [r#"{}"#, r#"{"models":null}"#, r#"{"models":{}}"#] {
            let transport = ScriptedTransport::single(json_response(StatusCode::OK, body));
            let models = fetch_ollama_tags(&transport, &env(), "sk")
                .await
                .expect("tags");
            assert!(models.is_empty(), "{body}");
        }
    }

    /// `if (!response.ok) return []` (`ollama/index.ts:42`).
    #[tokio::test]
    async fn a_non_2xx_status_yields_an_empty_list() {
        let transport = ScriptedTransport::single(json_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            r#"{"models":[{"name":"llama3.2"}]}"#,
        ));
        let models = fetch_ollama_tags(&transport, &env(), "sk")
            .await
            .expect("tags");
        assert!(models.is_empty());
    }

    /// An undecodable 2xx body propagates as the `SyntaxError` the callers catch.
    #[tokio::test]
    async fn an_undecodable_body_is_an_invalid_body_error() {
        let transport =
            ScriptedTransport::single(json_response(StatusCode::OK, "<html>nope</html>"));
        let error = fetch_ollama_tags(&transport, &env(), "sk")
            .await
            .expect_err("invalid body");
        assert!(matches!(error, HttpError::InvalidBody(_)), "{error:?}");
    }

    /// `mergeUniqueModels` keeps the first occurrence of every id and drops the
    /// empty ones (`ollama/index.ts:17-26`).
    #[test]
    fn merge_unique_models_keeps_the_first_id_and_drops_empties() {
        let primary = vec![
            FetchedModel {
                id: String::new(),
                name: "nameless".to_string(),
                provider: PROVIDER_ID.to_string(),
                owned_by: None,
                context_window: None,
                created: None,
                billing: None,
            },
            FetchedModel {
                id: "llama3.2".to_string(),
                name: "remote".to_string(),
                provider: PROVIDER_ID.to_string(),
                owned_by: None,
                context_window: None,
                created: None,
                billing: None,
            },
        ];
        let merged = merge_unique_models(primary, map_default_models(&["llama3.2".to_string()]));
        assert_eq!(ids(&merged), vec!["llama3.2"]);
        assert_eq!(merged[0].name, "remote", "the remote entry wins");
    }

    /// `mapDefaultModels` copies `provider.defaultModels` verbatim
    /// (`ollama/index.ts:61`), which for the catalog is `llama3.2`,
    /// `qwen2.5-coder`.
    #[test]
    fn the_catalog_default_models_are_the_fallback() {
        let provider = find_provider(PROVIDER_ID).expect("catalog");
        assert_eq!(provider.default_models, vec!["llama3.2", "qwen2.5-coder"]);
        let mapped = map_default_models(&provider.default_models);
        assert_eq!(ids(&mapped), vec!["llama3.2", "qwen2.5-coder"]);
        assert_eq!(mapped[0].name, "llama3.2");
        assert_eq!(mapped[0].provider, PROVIDER_ID);
    }

    /// The catalog's `apiBaseUrl` carries `/v1` while the adapter builds its own
    /// origin, so the tags URL must not inherit the `/v1`.
    #[test]
    fn the_catalog_api_base_url_is_not_the_probe_base() {
        let provider = find_provider(PROVIDER_ID).expect("catalog");
        assert_eq!(
            provider.api_base_url.as_deref(),
            Some("http://localhost:11434/v1")
        );
        assert_eq!(base_url(&env()), DEFAULT_BASE_URL);
    }

    /// `fetchModels` merges the remote tags ahead of the catalog fallback and
    /// deduplicates (`ollama/index.ts:59-63`).
    #[tokio::test]
    async fn fetch_models_puts_the_remote_tags_ahead_of_the_defaults() {
        let transport = ScriptedTransport::single(json_response(
            StatusCode::OK,
            r#"{"models":[{"name":"qwen2.5-coder"},{"name":"mistral"}]}"#,
        ));
        let models = OllamaAdapter
            .fetch_models(&context("sk"), &call(&transport, &env()))
            .await
            .expect("fetch");
        assert_eq!(ids(&models), vec!["qwen2.5-coder", "mistral", "llama3.2"]);
    }

    /// `.catch(() => [])`: a transport failure degrades to the catalog defaults
    /// instead of rejecting.
    #[tokio::test]
    async fn a_transport_failure_degrades_to_the_catalog_defaults() {
        let env = env();
        let call = ProviderCall {
            transport: &UnreachableTransport,
            attachments: &NOOP_ATTACHMENT_STORE,
            env: &env,
        };
        let models = OllamaAdapter
            .fetch_models(&context("sk"), &call)
            .await
            .expect("fetch");
        assert_eq!(ids(&models), vec!["llama3.2", "qwen2.5-coder"]);
    }

    /// An Ollama without tags still has to report the two catalog defaults.
    #[tokio::test]
    async fn an_empty_tags_list_still_yields_the_defaults() {
        let transport =
            ScriptedTransport::single(json_response(StatusCode::OK, r#"{"models":[]}"#));
        let models = OllamaAdapter
            .fetch_models(&context("sk"), &call(&transport, &env()))
            .await
            .expect("fetch");
        assert_eq!(ids(&models), vec!["llama3.2", "qwen2.5-coder"]);
    }

    /// A reachable Ollama with at least one model verifies connectivity
    /// (`ollama/index.ts:66-72`).
    #[tokio::test]
    async fn connectivity_ok_requires_at_least_one_model() {
        let transport = ScriptedTransport::single(json_response(
            StatusCode::OK,
            r#"{"models":[{"name":"llama3.2"}]}"#,
        ));
        let result = OllamaAdapter
            .test_connectivity(&context("sk"), &call(&transport, &env()), None)
            .await;
        assert!(result.ok);
        assert_eq!(result.message, CONNECTIVITY_OK);
    }

    /// The `models.length > 0` condition of `ollama/index.ts:67-71`: zero models
    /// is a failure even though the HTTP call succeeded.
    #[tokio::test]
    async fn connectivity_reports_no_models_as_a_failure() {
        let transport =
            ScriptedTransport::single(json_response(StatusCode::OK, r#"{"models":[]}"#));
        let result = OllamaAdapter
            .test_connectivity(&context("sk"), &call(&transport, &env()), None)
            .await;
        assert!(!result.ok);
        assert_eq!(result.message, CONNECTIVITY_NO_MODELS);
    }

    /// A non-2xx tags response yields an empty list too, so it reports the same
    /// message instead of the HTTP status.
    #[tokio::test]
    async fn connectivity_reports_a_non_2xx_status_as_no_models() {
        let transport = ScriptedTransport::single(json_response(StatusCode::UNAUTHORIZED, "nope"));
        let result = OllamaAdapter
            .test_connectivity(&context("sk"), &call(&transport, &env()), None)
            .await;
        assert!(!result.ok);
        assert_eq!(result.message, CONNECTIVITY_NO_MODELS);
    }

    /// The `.catch` branch (`ollama/index.ts:73-78`) prefixes the error text.
    #[tokio::test]
    async fn connectivity_reports_the_error_message_of_a_rejected_request() {
        let env = env();
        let call = ProviderCall {
            transport: &UnreachableTransport,
            attachments: &NOOP_ATTACHMENT_STORE,
            env: &env,
        };
        let result = OllamaAdapter
            .test_connectivity(&context("sk"), &call, None)
            .await;
        assert!(!result.ok);
        assert_eq!(
            result.message,
            "Ollama connectivity failed: No HTTP transport is configured."
        );
    }

    /// `dispatchGateway` posts to `${ollamaBaseUrl()}/v1/chat/completions`
    /// (`ollama/index.ts:80`) with the shared OpenAI-compatible body.
    #[tokio::test]
    async fn dispatch_posts_to_the_v1_chat_endpoint() {
        let transport = ScriptedTransport::single(json_response(
            StatusCode::OK,
            r#"{"choices":[{"message":{"content":"ok"}}],"model":"llama3.2"}"#,
        ));
        let response = OllamaAdapter
            .dispatch_gateway(
                &context("sk-ollama"),
                &call(&transport, &env()),
                &GatewayRequest::new("llama3.2", vec![GatewayMessage::user("hi")]),
                &DispatchOptions::default(),
            )
            .await
            .expect("dispatch");

        assert!(response.ok);
        assert_eq!(response.text, "ok");
        assert_eq!(response.provider, PROVIDER_ID);
        let seen = transport.seen.lock().expect("lock");
        assert_eq!(
            seen[0].url, "http://localhost:11434/v1/chat/completions",
            "the /v1 suffix is appended by the adapter"
        );
        assert_eq!(
            seen[0].body.as_deref().expect("body"),
            r#"{"model":"llama3.2","messages":[{"role":"user","content":"hi"}],"max_tokens":4096,"temperature":0.7,"stream":false}"#
        );
    }

    /// The documented asymmetry: `/api/tags` sends the raw trimmed secret, while
    /// the shared header builder normalises the same secret for the chat call.
    #[tokio::test]
    async fn the_tags_probe_sends_the_raw_secret_while_the_chat_call_normalises_it() {
        let transport = ScriptedTransport::new(vec![
            json_response(StatusCode::OK, r#"{"models":[{"name":"llama3.2"}]}"#),
            json_response(
                StatusCode::OK,
                r#"{"choices":[{"message":{"content":"ok"}}],"model":"llama3.2"}"#,
            ),
        ]);
        let env = env();
        let context = context("  \"sk-quoted\"  ");
        fetch_ollama_tags(&transport, &env, &context.secret)
            .await
            .expect("tags");
        OllamaAdapter
            .dispatch_gateway(
                &context,
                &call(&transport, &env),
                &GatewayRequest::new("llama3.2", vec![GatewayMessage::user("hi")]),
                &DispatchOptions::default(),
            )
            .await
            .expect("dispatch");

        let seen = transport.seen.lock().expect("lock");
        assert_eq!(
            seen[0].headers.get("authorization").expect("tags auth"),
            "Bearer \"sk-quoted\"",
            "ollama/index.ts:31 trims only"
        );
        assert_eq!(
            seen[1].headers.get("authorization").expect("chat auth"),
            "Bearer sk-quoted",
            "buildRequestHeaders normalises"
        );
    }
}
