//! Port of `src/server/model-hub/Models/github-copilot/index.ts`.
//!
//! | Rust | TypeScript |
//! | --- | --- |
//! | [`MARKETPLACE_MODELS_URL`] | `'https://api.github.com/marketplace_listing/models'` (`github-copilot/index.ts:9`) |
//! | [`INFERENCE_INFO_URL`] | `'https://models.inference.ai.azure.com/info'` (`:19`, `:60`) |
//! | [`GITHUB_USER_URL`] | `'https://api.github.com/user'` (`:72`) |
//! | [`INFERENCE_BASE_URL`] | `'https://models.inference.ai.azure.com'` (`:87`) |
//! | [`GITHUB_ACCEPT`] | `'application/vnd.github+json'` (`:13`, `:76`) |
//! | [`GITHUB_API_VERSION`] | `'2022-11-28'` (`:14`) |
//! | [`GITHUB_MODELS_FALLBACK`], [`hard_coded_models`] | the four literal entries of `:38-43` |
//! | [`GithubCopilotAdapter`] | `githubProviderAdapter` (`:5-96`) |
//! | [`CONNECTIVITY_OK`] | `:68` |
//! | [`USER_CONNECTIVITY_OK`] | `:81` |
//! | [`CONNECTIVITY_FAILURE_PREFIX`] | `:82` |
//!
//! This is the only adapter in the slice whose `fetchModels` does not use the
//! shared `/models` helper: it walks a GitHub REST listing with three provider
//! headers, falls back to the legacy Azure inference `/info` listing, and finally
//! to four hard-coded ids. The catalog entry is `github-native` with an **empty**
//! `defaultModels` (`providerCatalog.ts`; asserted by
//! `provider_catalog.rs::only_github_copilot_has_no_default_models`), so the four
//! literals below — not a catalog list — are the last resort.
//!
//! `dispatchGateway` does use the shared layer, against the legacy inference
//! origin `${INFERENCE_BASE_URL}/chat/completions`.
//!
//! # Deviations from the TypeScript
//!
//! - **`String(value)` coercion.** `String(record.id || record.model_name || '')`
//!   (`:30`) and its three siblings (`:31`, `:53`, `:54`) go through
//!   [`js_or_string`], which reproduces the `||` truthiness order and the
//!   `String()` coercion for JSON strings and numbers. A JSON `true`, object or
//!   array is treated as absent instead of becoming `"true"`/`"[object Object]"`;
//!   GitHub's listings never send those.
//! - **Empty ids are kept.** `String('' || '' || '')` is `''`, and neither mapping
//!   filters, so an entry without `id`/`name` (marketplace) or without
//!   `id`/`model_name` (`/info`) becomes a model with an empty id. Ported as-is;
//!   `FetchedModel.id` is a plain `String`.
//! - **Raw secret.** All three raw calls authorise with `` `Bearer ${secret}` ``
//!   (`:12`, `:21`, `:62`, `:75`) with no `trim` and no `normalizeBearerSecret`,
//!   unlike the shared `/models` helper other providers use. Only the chat
//!   dispatch normalises, through the shared header builder. Ported as-is.
//!   [`HttpRequest::header`] drops a value the `http` crate rejects — a secret
//!   with leading or trailing whitespace, for example — where Node's `fetch`
//!   throws a `TypeError` instead; that difference belongs to the shared seam and
//!   is not introduced here.
//! - **`fetchJsonOk` timeout.** `:60` and `:72` pass no third argument, so the
//!   shared default of 15 s applies; the port passes
//!   [`DEFAULT_REQUEST_TIMEOUT_MS`] explicitly, which is the same value.
//! - **`.catch(() => null)` around the fallback listing.** `:19-25`: a transport
//!   failure of the `/info` probe, and a `response.json()` that throws, both read
//!   as `null` and end in the hard-coded list. The port maps both onto the same
//!   outcome with `.ok()` and an ignoring `serde_json` parse. The `response.ok`
//!   check of `:24` runs *before* the parse, so a non-2xx `/info` never reaches
//!   the parser in either language.
//! - **The marketplace `response.json()` propagates.** `:46` is outside any
//!   `.catch`, so an undecodable 2xx body rejects `fetchModels`;
//!   `modelFetcher.ts:57-66` catches it. The port returns
//!   `Err(`[`HttpError::InvalidBody`]`)`.
//! - **`Array.isArray`.** A non-array body (a JSON object or a bare `null`) reads
//!   as "no models" (`:52`), which is what the port does with
//!   `Value::as_array`.
//! - **The first probe's message wins.** `:82` reports `result.message` from the
//!   *Azure* probe even though the `/user` probe is what failed last. Ported
//!   verbatim, including the fact that the second result's message is never shown.
//! - **No environment reads.** The file touches no `process.env` variable, so
//!   [`ProviderCall::env`] is unused here (the compiler enforces that by the
//!   underscore binding in `test_connectivity`/`dispatch_gateway`, and
//!   `fetch_models` never mentions `call.env`).
//!
//! # SDK usage in the TypeScript
//!
//! None. `github-copilot/index.ts` uses `fetchWithTimeout`/`fetchJsonOk` and the
//! shared OpenAI-compatible dispatcher, so this port is REST against the injected
//! [`HttpTransport`] with no SDK translation.

use serde_json::Value;

use crate::model_hub::http::{
    fetch_json_ok, fetch_with_timeout, BoxFuture, HttpError, HttpRequest, HttpResponse,
    HttpTransport, JsonOkResult, DEFAULT_REQUEST_TIMEOUT_MS,
};
use crate::model_hub::openai_compatible::{dispatch_openai_compatible_chat, DispatchOptions};
use crate::model_hub::types::{
    ConnectivityResult, FetchedModel, GatewayRequest, GatewayResponse, ProviderExecutionContext,
};

use super::{ProviderAdapter, ProviderCall};

/// `id: 'github-copilot'` from `github-copilot/index.ts:6`.
pub const PROVIDER_ID: &str = "github-copilot";
/// `'https://api.github.com/marketplace_listing/models'` from
/// `github-copilot/index.ts:9`.
pub const MARKETPLACE_MODELS_URL: &str = "https://api.github.com/marketplace_listing/models";
/// `'https://models.inference.ai.azure.com/info'` from
/// `github-copilot/index.ts:19` and `:60`.
pub const INFERENCE_INFO_URL: &str = "https://models.inference.ai.azure.com/info";
/// `'https://api.github.com/user'` from `github-copilot/index.ts:72`.
pub const GITHUB_USER_URL: &str = "https://api.github.com/user";
/// `'https://models.inference.ai.azure.com'` from `github-copilot/index.ts:87`.
pub const INFERENCE_BASE_URL: &str = "https://models.inference.ai.azure.com";
/// `'application/vnd.github+json'` from `github-copilot/index.ts:13` and `:76`.
pub const GITHUB_ACCEPT: &str = "application/vnd.github+json";
/// `'2022-11-28'` from `github-copilot/index.ts:14`.
pub const GITHUB_API_VERSION: &str = "2022-11-28";
/// `'GitHub Models connectivity verified (inference endpoint reachable).'` from
/// `github-copilot/index.ts:68`.
pub const CONNECTIVITY_OK: &str =
    "GitHub Models connectivity verified (inference endpoint reachable).";
/// `'GitHub connectivity verified (user endpoint reachable).'` from
/// `github-copilot/index.ts:81`.
pub const USER_CONNECTIVITY_OK: &str = "GitHub connectivity verified (user endpoint reachable).";
/// `'GitHub connectivity failed: '` from `github-copilot/index.ts:82`.
pub const CONNECTIVITY_FAILURE_PREFIX: &str = "GitHub connectivity failed: ";

/// The four `{ id, name }` literals of `github-copilot/index.ts:38-43`.
pub const GITHUB_MODELS_FALLBACK: &[(&str, &str)] = &[
    ("gpt-4o", "GPT-4o (GitHub)"),
    ("gpt-4o-mini", "GPT-4o Mini (GitHub)"),
    ("o1-preview", "o1-preview (GitHub)"),
    ("o1-mini", "o1-mini (GitHub)"),
];

/// The `return [ … ]` of `github-copilot/index.ts:38-43`.
pub fn hard_coded_models() -> Vec<FetchedModel> {
    GITHUB_MODELS_FALLBACK
        .iter()
        .map(|(id, name)| FetchedModel {
            id: (*id).to_string(),
            name: (*name).to_string(),
            provider: PROVIDER_ID.to_string(),
            owned_by: None,
            context_window: None,
            created: None,
            billing: None,
        })
        .collect()
}

/// `String(a || b || c || '')` over the given keys, in order.
///
/// The `||` chain picks the first *truthy* value, which excludes the empty string
/// and the number zero; `String()` then repeats a string or formats a number.
/// See the module note for the values this cannot represent.
fn js_or_string(record: &Value, keys: &[&str]) -> String {
    for key in keys {
        match record.get(*key) {
            Some(Value::String(text)) if !text.is_empty() => return text.clone(),
            Some(Value::Number(number)) if number.as_f64() != Some(0.0) => {
                return number.to_string();
            }
            _ => {}
        }
    }
    String::new()
}

/// The mapping of `github-copilot/index.ts:27-34` for the legacy `/info` body:
/// `` id: String(record.id || record.model_name || '') `` and
/// `` name: String(record.model_name || record.id || '') ``.
fn inference_info_model(entry: &Value) -> FetchedModel {
    FetchedModel {
        id: js_or_string(entry, &["id", "model_name"]),
        name: js_or_string(entry, &["model_name", "id"]),
        provider: PROVIDER_ID.to_string(),
        owned_by: None,
        context_window: None,
        created: None,
        billing: None,
    }
}

/// The mapping of `github-copilot/index.ts:52-56` for the marketplace body:
/// `` id: String(model.id || model.name || '') `` and
/// `` name: String(model.friendly_name || model.name || model.id || '') ``.
fn marketplace_model(entry: &Value) -> FetchedModel {
    FetchedModel {
        id: js_or_string(entry, &["id", "name"]),
        name: js_or_string(entry, &["friendly_name", "name", "id"]),
        provider: PROVIDER_ID.to_string(),
        owned_by: None,
        context_window: None,
        created: None,
        billing: None,
    }
}

/// `` `Bearer ${secret}` `` — the raw secret, never trimmed
/// (`github-copilot/index.ts:12`, `:21`, `:62`, `:75`).
fn authorization(secret: &str) -> String {
    format!("Bearer {secret}")
}

/// The `Authorization`, `Accept` and `X-GitHub-Api-Version` trio of
/// `github-copilot/index.ts:11-15`.
fn github_headers(request: HttpRequest, secret: &str) -> HttpRequest {
    request
        .header("Authorization", &authorization(secret))
        .header("Accept", GITHUB_ACCEPT)
        .header("X-GitHub-Api-Version", GITHUB_API_VERSION)
}

/// `fetchModels` from `github-copilot/index.ts:8-57`.
///
/// Three stages, each with its own failure policy:
/// 1. the marketplace listing — a transport failure or an undecodable body
///    propagates;
/// 2. on a non-2xx status the legacy Azure `/info` listing, whose transport
///    failure and body failure both read as "no fallback";
/// 3. otherwise the four hard-coded ids.
pub async fn fetch_models(
    transport: &dyn HttpTransport,
    secret: &str,
) -> Result<Vec<FetchedModel>, HttpError> {
    let response = fetch_with_timeout(
        transport,
        github_headers(HttpRequest::get(MARKETPLACE_MODELS_URL), secret),
    )
    .await?;

    if !response.is_ok() {
        let fallback = fetch_with_timeout(
            transport,
            HttpRequest::get(INFERENCE_INFO_URL).header("Authorization", &authorization(secret)),
        )
        .await
        .ok()
        .filter(HttpResponse::is_ok);

        // `.catch(() => null)` around both the request and `response.json()`.
        let models = fallback
            .and_then(|fallback| serde_json::from_str::<Value>(&fallback.body).ok())
            .and_then(|info| {
                info.as_array().map(|entries| {
                    entries
                        .iter()
                        .map(inference_info_model)
                        .collect::<Vec<FetchedModel>>()
                })
            });

        return Ok(models.unwrap_or_else(hard_coded_models));
    }

    let json: Value = serde_json::from_str(&response.body)
        .map_err(|error| HttpError::InvalidBody(error.to_string()))?;

    Ok(json
        .as_array()
        .map(|entries| entries.iter().map(marketplace_model).collect())
        .unwrap_or_default())
}

/// `githubProviderAdapter` from `github-copilot/index.ts:5-96`.
#[derive(Debug, Clone, Copy, Default)]
pub struct GithubCopilotAdapter;

impl ProviderAdapter for GithubCopilotAdapter {
    fn id(&self) -> &'static str {
        PROVIDER_ID
    }

    /// `github-copilot/index.ts:8-57`. Read no `process.env` variable, so
    /// [`ProviderCall::env`] stays untouched.
    fn fetch_models<'a>(
        &'a self,
        context: &'a ProviderExecutionContext,
        call: &'a ProviderCall<'_>,
    ) -> BoxFuture<'a, Result<Vec<FetchedModel>, HttpError>> {
        Box::pin(async move { fetch_models(call.transport, &context.secret).await })
    }

    /// `github-copilot/index.ts:59-83`: probe the legacy inference endpoint first
    /// and fall back to `/user`; a failure of both reports the *first* probe's
    /// message.
    fn test_connectivity<'a>(
        &'a self,
        context: &'a ProviderExecutionContext,
        call: &'a ProviderCall<'_>,
        _model: Option<&'a str>,
    ) -> BoxFuture<'a, ConnectivityResult> {
        Box::pin(async move {
            let result = fetch_json_ok(
                call.transport,
                HttpRequest::get(INFERENCE_INFO_URL)
                    .header("Authorization", &authorization(&context.secret)),
                DEFAULT_REQUEST_TIMEOUT_MS,
            )
            .await;

            let JsonOkResult::Err(message) = result else {
                return ConnectivityResult::ok(CONNECTIVITY_OK);
            };

            let user_result = fetch_json_ok(
                call.transport,
                HttpRequest::get(GITHUB_USER_URL)
                    .header("Authorization", &authorization(&context.secret))
                    .header("Accept", GITHUB_ACCEPT),
                DEFAULT_REQUEST_TIMEOUT_MS,
            )
            .await;

            if user_result.is_ok() {
                ConnectivityResult::ok(USER_CONNECTIVITY_OK)
            } else {
                ConnectivityResult::failed(format!("{CONNECTIVITY_FAILURE_PREFIX}{message}"))
            }
        })
    }

    /// `github-copilot/index.ts:85-95`: still the shared OpenAI-compatible chat
    /// call, against the legacy Azure inference origin.
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
                INFERENCE_BASE_URL,
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
    use crate::model_hub::env::EnvOverrides;
    use crate::model_hub::http::UnreachableTransport;
    use crate::model_hub::openai_compatible::NOOP_ATTACHMENT_STORE;
    use crate::model_hub::provider_catalog::find_provider;
    use crate::model_hub::repository::encrypted_secret_input;
    use crate::model_hub::types::{GatewayMessage, ProviderAccountRecord, ProviderAuthMethod};

    /// Serves the scripted responses in order and keeps every request; a single
    /// scripted response answers forever, and `fail_at` makes exactly one call
    /// (by zero-based index) fail at the transport level.
    struct ScriptedTransport {
        responses: Mutex<VecDeque<HttpResponse>>,
        seen: Mutex<Vec<HttpRequest>>,
        fail_at: Option<usize>,
    }

    impl ScriptedTransport {
        fn new(responses: Vec<HttpResponse>) -> Self {
            Self {
                responses: Mutex::new(responses.into()),
                seen: Mutex::new(Vec::new()),
                fail_at: None,
            }
        }

        fn single(response: HttpResponse) -> Self {
            Self::new(vec![response])
        }

        fn failing_at(index: usize, responses: Vec<HttpResponse>) -> Self {
            Self {
                fail_at: Some(index),
                ..Self::new(responses)
            }
        }
    }

    impl HttpTransport for ScriptedTransport {
        fn send<'a>(
            &'a self,
            request: HttpRequest,
        ) -> BoxFuture<'a, Result<HttpResponse, HttpError>> {
            let index = {
                let mut seen = self.seen.lock().expect("the request log is never poisoned");
                let index = seen.len();
                seen.push(request);
                index
            };
            if self.fail_at == Some(index) {
                return Box::pin(async {
                    Err(HttpError::Transport("the script failed".to_string()))
                });
            }

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

    fn text_response(status: StatusCode, body: &str) -> HttpResponse {
        HttpResponse::text(status, body)
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
                .expect("github-copilot is in the catalog")
                .clone(),
            account: ProviderAccountRecord {
                id: "acc-gh".to_string(),
                provider_id: PROVIDER_ID.to_string(),
                label: "github".to_string(),
                auth_method: ProviderAuthMethod::Oauth,
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

    fn ids(models: &[FetchedModel]) -> Vec<&str> {
        models.iter().map(|model| model.id.as_str()).collect()
    }

    /// The marketplace probe: `GET` with the three GitHub headers, the raw secret
    /// and the shared 15 s default (`github-copilot/index.ts:9-16`).
    #[tokio::test]
    async fn the_marketplace_probe_uses_the_github_headers() {
        let transport = ScriptedTransport::single(json_response(StatusCode::OK, "[]"));
        let models = fetch_models(&transport, "gh-token").await.expect("fetch");
        assert!(models.is_empty());

        let seen = transport.seen.lock().expect("lock");
        assert_eq!(
            seen[0].url,
            "https://api.github.com/marketplace_listing/models"
        );
        assert_eq!(seen[0].method, http::Method::GET);
        assert_eq!(seen[0].timeout_ms, DEFAULT_REQUEST_TIMEOUT_MS);
        assert_eq!(
            seen[0].headers.get("authorization").expect("auth"),
            "Bearer gh-token"
        );
        assert_eq!(
            seen[0].headers.get("accept").expect("accept"),
            GITHUB_ACCEPT
        );
        assert_eq!(
            seen[0]
                .headers
                .get("x-github-api-version")
                .expect("version"),
            GITHUB_API_VERSION
        );
    }

    /// The secret reaches the marketplace probe verbatim: no `trim`, no
    /// `normalizeBearerSecret` (`github-copilot/index.ts:12`).
    #[tokio::test]
    async fn the_marketplace_probe_sends_the_raw_secret() {
        let transport = ScriptedTransport::single(json_response(StatusCode::OK, "[]"));
        fetch_models(&transport, "\"gh-quoted\"")
            .await
            .expect("fetch");
        let seen = transport.seen.lock().expect("lock");
        assert_eq!(
            seen[0].headers.get("authorization").expect("auth"),
            "Bearer \"gh-quoted\""
        );
    }

    /// `id: String(model.id || model.name || '')`,
    /// `name: String(model.friendly_name || model.name || model.id || '')`
    /// (`github-copilot/index.ts:52-56`).
    #[tokio::test]
    async fn marketplace_entries_prefer_id_and_friendly_name() {
        let transport = ScriptedTransport::single(json_response(
            StatusCode::OK,
            r#"[
                {"id":"gpt-4o","name":"slug","friendly_name":"GPT-4o"},
                {"name":"only-name"},
                {"id":"only-id"},
                {},
                "not-an-object"
            ]"#,
        ));
        let models = fetch_models(&transport, "gh").await.expect("fetch");
        assert_eq!(ids(&models), vec!["gpt-4o", "only-name", "only-id", "", ""]);
        assert_eq!(models[0].name, "GPT-4o");
        assert_eq!(models[0].provider, PROVIDER_ID);
        // `String(model.friendly_name || model.name || model.id || '')`.
        assert_eq!(models[1].name, "only-name");
        assert_eq!(models[2].name, "only-id");
        assert_eq!(
            models[3].id, "",
            "an entry without id/name keeps an empty id"
        );
        assert_eq!(models[4].id, "");
    }

    /// A JSON `0` is falsy in the `||` chain and is skipped (`:53`).
    #[tokio::test]
    async fn a_zero_id_falls_through_to_the_next_key() {
        let transport = ScriptedTransport::single(json_response(
            StatusCode::OK,
            r#"[{"id":0,"name":"real-name"}]"#,
        ));
        let models = fetch_models(&transport, "gh").await.expect("fetch");
        assert_eq!(ids(&models), vec!["real-name"]);
        assert_eq!(models[0].name, "real-name");
    }

    /// `Array.isArray(json) ? json : []` (`github-copilot/index.ts:52`).
    #[tokio::test]
    async fn a_non_array_marketplace_body_yields_an_empty_list() {
        for body in [r#"{"id":"gpt-4o"}"#, "null", "123"] {
            let transport = ScriptedTransport::single(json_response(StatusCode::OK, body));
            let models = fetch_models(&transport, "gh").await.expect("fetch");
            assert!(models.is_empty(), "{body}");
        }
    }

    /// The marketplace `response.json()` is outside any `.catch`, so it
    /// propagates (`github-copilot/index.ts:46`).
    #[tokio::test]
    async fn an_undecodable_marketplace_body_is_an_invalid_body_error() {
        let transport =
            ScriptedTransport::single(json_response(StatusCode::OK, "<html>nope</html>"));
        let error = fetch_models(&transport, "gh")
            .await
            .expect_err("invalid body");
        assert!(matches!(error, HttpError::InvalidBody(_)), "{error:?}");
    }

    /// The Azure fallback only runs for a non-2xx *status*; a transport failure
    /// rejects before it (`github-copilot/index.ts:9-22`).
    #[tokio::test]
    async fn a_marketplace_transport_failure_propagates_without_the_fallback() {
        let transport = ScriptedTransport::failing_at(
            0,
            vec![json_response(StatusCode::OK, r#"[{"id":"x"}]"#)],
        );
        let error = fetch_models(&transport, "gh")
            .await
            .expect_err("transport failure");
        assert_eq!(error, HttpError::Transport("the script failed".to_string()));
        assert_eq!(
            transport.seen.lock().expect("lock").len(),
            1,
            "the fallback is not attempted"
        );
    }

    /// A non-2xx marketplace status plus a reachable `/info` array lists the
    /// legacy models (`github-copilot/index.ts:19-36`).
    #[tokio::test]
    async fn the_azure_fallback_lists_the_legacy_models() {
        let transport = ScriptedTransport::new(vec![
            json_response(StatusCode::FORBIDDEN, "{}"),
            json_response(
                StatusCode::OK,
                r#"[{"id":"gpt-4o","model_name":"GPT-4o Legacy"},{"model_name":"no-id"}]"#,
            ),
        ]);
        let models = fetch_models(&transport, "gh").await.expect("fetch");
        assert_eq!(ids(&models), vec!["gpt-4o", "no-id"]);
        assert_eq!(models[0].name, "GPT-4o Legacy");
        assert_eq!(models[1].name, "no-id");
        assert_eq!(models[0].provider, PROVIDER_ID);

        let seen = transport.seen.lock().expect("lock");
        assert_eq!(seen[1].url, "https://models.inference.ai.azure.com/info");
        assert_eq!(
            seen[1].headers.get("authorization").expect("auth"),
            "Bearer gh"
        );
        assert!(
            seen[1].headers.get("x-github-api-version").is_none(),
            "the fallback sends only Authorization"
        );
    }

    /// `/info` answering with a non-array body reads as "no fallback"
    /// (`github-copilot/index.ts:25-35`).
    #[tokio::test]
    async fn a_non_array_azure_body_falls_through_to_the_hard_coded_models() {
        for body in [r#"{"models":[]}"#, "null", "<html>nope</html>"] {
            let transport = ScriptedTransport::new(vec![
                json_response(StatusCode::FORBIDDEN, "{}"),
                json_response(StatusCode::OK, body),
            ]);
            let models = fetch_models(&transport, "gh").await.expect("fetch");
            assert_eq!(
                ids(&models),
                vec!["gpt-4o", "gpt-4o-mini", "o1-preview", "o1-mini"],
                "{body}"
            );
        }
    }

    /// A second non-2xx status, and a transport failure of the fallback, both end
    /// in the hard-coded list (`github-copilot/index.ts:19-43`).
    #[tokio::test]
    async fn a_failed_fallback_yields_the_hard_coded_models() {
        let transport = ScriptedTransport::new(vec![
            json_response(StatusCode::FORBIDDEN, "{}"),
            json_response(StatusCode::UNAUTHORIZED, "nope"),
        ]);
        let models = fetch_models(&transport, "gh").await.expect("fetch");
        assert_eq!(models[0].name, "GPT-4o (GitHub)");

        let transport =
            ScriptedTransport::failing_at(1, vec![json_response(StatusCode::FORBIDDEN, "{}")]);
        let models = fetch_models(&transport, "gh").await.expect("fetch");
        assert_eq!(
            ids(&models),
            vec!["gpt-4o", "gpt-4o-mini", "o1-preview", "o1-mini"]
        );
        assert_eq!(models[1].name, "GPT-4o Mini (GitHub)");
    }

    /// The catalog entry carries no defaults, which is why the four literals are
    /// the last resort (`providerCatalog.ts`).
    #[test]
    fn the_catalog_entry_has_no_default_models() {
        let provider = find_provider(PROVIDER_ID).expect("catalog");
        assert!(provider.default_models.is_empty());
        assert_eq!(
            provider.api_base_url.as_deref(),
            Some("https://api.github.com")
        );
        assert_eq!(hard_coded_models().len(), GITHUB_MODELS_FALLBACK.len());
    }

    /// `github-copilot/index.ts:60-70`: a reachable inference endpoint is enough.
    #[tokio::test]
    async fn connectivity_is_verified_by_the_inference_endpoint() {
        let transport = ScriptedTransport::single(json_response(StatusCode::OK, "[]"));
        let env = EnvOverrides::new();
        let result = GithubCopilotAdapter
            .test_connectivity(&context("gh"), &call(&transport, &env), None)
            .await;

        assert!(result.ok);
        assert_eq!(result.message, CONNECTIVITY_OK);
        let seen = transport.seen.lock().expect("lock");
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].url, "https://models.inference.ai.azure.com/info");
        assert_eq!(seen[0].method, http::Method::GET);
        assert_eq!(seen[0].timeout_ms, DEFAULT_REQUEST_TIMEOUT_MS);
        assert_eq!(
            seen[0].headers.get("authorization").expect("auth"),
            "Bearer gh"
        );
        assert!(seen[0].headers.get("accept").is_none());
    }

    /// `github-copilot/index.ts:72-82`: `/user` rescues a failed `/info`.
    #[tokio::test]
    async fn the_user_endpoint_rescues_a_failed_inference_probe() {
        let transport = ScriptedTransport::new(vec![
            text_response(StatusCode::UNAUTHORIZED, "azure says no"),
            json_response(StatusCode::OK, r#"{"login":"octocat"}"#),
        ]);
        let env = EnvOverrides::new();
        let result = GithubCopilotAdapter
            .test_connectivity(&context("gh"), &call(&transport, &env), None)
            .await;

        assert!(result.ok);
        assert_eq!(result.message, USER_CONNECTIVITY_OK);
        let seen = transport.seen.lock().expect("lock");
        assert_eq!(seen[1].url, "https://api.github.com/user");
        assert_eq!(
            seen[1].headers.get("authorization").expect("auth"),
            "Bearer gh"
        );
        assert_eq!(
            seen[1].headers.get("accept").expect("accept"),
            GITHUB_ACCEPT
        );
        assert!(seen[1].headers.get("x-github-api-version").is_none());
    }

    /// `github-copilot/index.ts:80-82`: when both probes fail the message is the
    /// *first* one, never the `/user` result.
    #[tokio::test]
    async fn two_failed_probes_report_the_inference_message() {
        let transport = ScriptedTransport::new(vec![
            text_response(StatusCode::UNAUTHORIZED, "  azure says no  "),
            text_response(StatusCode::FORBIDDEN, "github says no"),
        ]);
        let env = EnvOverrides::new();
        let result = GithubCopilotAdapter
            .test_connectivity(&context("gh"), &call(&transport, &env), None)
            .await;

        assert!(!result.ok);
        assert_eq!(result.message, "GitHub connectivity failed: azure says no");

        // A JSON error body goes through `parseErrorMessage`'s precedence.
        let transport = ScriptedTransport::new(vec![
            json_response(
                StatusCode::UNAUTHORIZED,
                r#"{"error":{"message":"nested reason"}}"#,
            ),
            text_response(StatusCode::FORBIDDEN, "github says no"),
        ]);
        let result = GithubCopilotAdapter
            .test_connectivity(&context("gh"), &call(&transport, &env), None)
            .await;
        assert_eq!(result.message, "GitHub connectivity failed: nested reason");
    }

    /// A transport failure of both probes reports the first probe's error text,
    /// because `fetchJsonOk` turns the throw into `{ ok: false, message }`
    /// (`github-copilot/index.ts:59-82`).
    #[tokio::test]
    async fn two_unreachable_probes_report_the_transport_error() {
        let env = EnvOverrides::new();
        let call = ProviderCall {
            transport: &UnreachableTransport,
            attachments: &NOOP_ATTACHMENT_STORE,
            env: &env,
        };
        let result = GithubCopilotAdapter
            .test_connectivity(&context("gh"), &call, None)
            .await;
        assert!(!result.ok);
        assert_eq!(
            result.message,
            "GitHub connectivity failed: No HTTP transport is configured."
        );
    }

    /// `github-copilot/index.ts:85-95`: the chat call keeps the shared
    /// OpenAI-compatible transport, only the base URL is Azure.
    #[tokio::test]
    async fn dispatch_posts_to_the_azure_inference_origin() {
        let transport = ScriptedTransport::single(json_response(
            StatusCode::OK,
            r#"{"choices":[{"message":{"content":"ok"}}],"model":"gpt-4o"}"#,
        ));
        let env = EnvOverrides::new();
        let response = GithubCopilotAdapter
            .dispatch_gateway(
                &context("gh"),
                &call(&transport, &env),
                &GatewayRequest::new("gpt-4o", vec![GatewayMessage::user("hi")]),
                &DispatchOptions::default(),
            )
            .await
            .expect("dispatch");

        assert!(response.ok);
        assert_eq!(response.provider, PROVIDER_ID);
        let seen = transport.seen.lock().expect("lock");
        assert_eq!(
            seen[0].url,
            "https://models.inference.ai.azure.com/chat/completions"
        );
        assert_eq!(
            seen[0].body.as_deref().expect("body"),
            r#"{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}],"max_tokens":4096,"temperature":0.7,"stream":false}"#
        );
    }
}
