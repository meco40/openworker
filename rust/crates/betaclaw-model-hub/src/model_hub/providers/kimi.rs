//! Port of `src/server/model-hub/Models/kimi/index.ts`.
//!
//! Kimi Code is the only ported adapter that **merges** two model lists: the
//! remote `/models` payload and the catalog's `defaultModels`, deduplicated by
//! id. The remote list wins, and an unreachable or non-2xx endpoint degrades to
//! the seed list alone — `models/fetch.ts` returns `[]` for a non-2xx status and
//! the `.catch(() => [])` swallows a transport failure, so `kimi-for-coding` is
//! always present.
//!
//! The connectivity probe is the shared models endpoint, but with a second,
//! provider-specific rewrite on top: an `invalid_authentication_error` is
//! replaced by a long hint about the Kimi *Code* key namespace.

use crate::model_hub::http::{BoxFuture, HttpError, HttpTransport};
use crate::model_hub::openai_compatible::{
    dispatch_openai_compatible_chat, fetch_openai_compatible_models,
    test_openai_compatible_models_endpoint, DispatchOptions,
};
use crate::model_hub::types::{
    ConnectivityResult, FetchedModel, GatewayRequest, GatewayResponse, ProviderExecutionContext,
};

use super::{ProviderAdapter, ProviderCall};

/// `KIMI_CODE_BASE_URL` from `kimi/index.ts:8`.
pub const BASE_URL: &str = "https://api.kimi.com/coding/v1";
/// `'kimi'` — the literal `provider` field of the mapped models.
pub const PROVIDER_ID: &str = "kimi";
/// `Kimi connectivity verified (models list reachable).` from `kimi/index.ts:46`.
pub const CONNECTIVITY_OK: &str = "Kimi connectivity verified (models list reachable).";
/// `Kimi connectivity failed: ` from `kimi/index.ts:47`.
pub const CONNECTIVITY_FAILURE_PREFIX: &str = "Kimi connectivity failed: ";
/// The hint that replaces an `invalid_authentication_error`, from
/// `kimi/index.ts:53-55`.
pub const INVALID_AUTHENTICATION_HINT: &str = "Kimi connectivity failed: Invalid Authentication (invalid_authentication_error). Use a Kimi Code key (sk-kimi-...) from kimi.com/code/console for endpoint api.kimi.com/coding/v1, without extra quotes/prefix.";
/// The seed used when the catalog entry carries no `defaultModels`
/// (`kimi/index.ts:38`).
pub const SEED_FALLBACK: &[&str] = &["kimi-for-coding"];

/// `mapDefaultModels` from `kimi/index.ts:10-16`.
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

/// `mergeUniqueModels` from `kimi/index.ts:18-27`: the first list wins, and a
/// falsy id is skipped — which in Rust means the empty string that
/// `fetchOpenAICompatibleModels` produces for an entry without `id`.
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

/// `fetchModels` from `kimi/index.ts:31-41`.
pub async fn fetch_models(
    transport: &dyn HttpTransport,
    secret: &str,
    default_models: &[String],
) -> Vec<FetchedModel> {
    let defaults: Vec<String> = if default_models.is_empty() {
        SEED_FALLBACK
            .iter()
            .map(|model| (*model).to_string())
            .collect()
    } else {
        default_models.to_vec()
    };
    // `[...new Set(fallbackDefaults)]` — the catalog list has no duplicates
    // today, so the deduplication is a no-op that keeps the port faithful.
    let mut unique_defaults: Vec<String> = Vec::new();
    for model in defaults {
        if !unique_defaults.contains(&model) {
            unique_defaults.push(model);
        }
    }

    // `.catch(() => [])`.
    let remote_models = fetch_openai_compatible_models(transport, BASE_URL, secret, PROVIDER_ID)
        .await
        .unwrap_or_default();
    merge_unique_models(remote_models, map_default_models(&unique_defaults))
}

/// `kimiProviderAdapter` from `kimi/index.ts:29-66`.
#[derive(Debug, Clone, Copy, Default)]
pub struct KimiAdapter;

impl ProviderAdapter for KimiAdapter {
    fn id(&self) -> &'static str {
        PROVIDER_ID
    }

    fn fetch_models<'a>(
        &'a self,
        context: &'a ProviderExecutionContext,
        call: &'a ProviderCall<'_>,
    ) -> BoxFuture<'a, Result<Vec<FetchedModel>, HttpError>> {
        Box::pin(async move {
            Ok(fetch_models(
                call.transport,
                &context.secret,
                &context.provider.default_models,
            )
            .await)
        })
    }

    fn test_connectivity<'a>(
        &'a self,
        context: &'a ProviderExecutionContext,
        call: &'a ProviderCall<'_>,
        _model: Option<&'a str>,
    ) -> BoxFuture<'a, ConnectivityResult> {
        Box::pin(async move {
            let result = test_openai_compatible_models_endpoint(
                call.transport,
                BASE_URL,
                &context.secret,
                CONNECTIVITY_OK,
                CONNECTIVITY_FAILURE_PREFIX,
            )
            .await;

            if !result.ok && result.message.contains("invalid_authentication_error") {
                return ConnectivityResult::failed(INVALID_AUTHENTICATION_HINT);
            }
            result
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
            dispatch_openai_compatible_chat(
                call.transport,
                call.attachments,
                BASE_URL,
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
    use std::sync::{Arc, Mutex};

    use http::{HeaderMap, StatusCode};

    use super::*;
    use crate::model_hub::env::EnvOverrides;
    use crate::model_hub::http::{HttpRequest, HttpResponse};
    use crate::model_hub::openai_compatible::NOOP_ATTACHMENT_STORE;
    use crate::model_hub::provider_catalog::find_provider;
    use crate::model_hub::repository::encrypted_secret_input;
    use crate::model_hub::types::{GatewayMessage, ProviderAccountRecord, ProviderAuthMethod};

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

    fn models_response(status: StatusCode, body: &str) -> HttpResponse {
        let mut headers = HeaderMap::new();
        headers.insert(
            http::header::CONTENT_TYPE,
            http::HeaderValue::from_static("application/json"),
        );
        HttpResponse::new(status, headers, body.to_string())
    }

    /// A `ProviderCall` over `transport`, with the storage seam closed and no
    /// environment overrides — kimi reads no `process.env` variable.
    fn call<'a>(transport: &'a StubTransport, env: &'a EnvOverrides) -> ProviderCall<'a> {
        ProviderCall {
            transport,
            attachments: &NOOP_ATTACHMENT_STORE,
            env,
        }
    }

    fn context(secret: &str) -> ProviderExecutionContext {
        ProviderExecutionContext {
            provider: find_provider("kimi")
                .expect("kimi is in the catalog")
                .clone(),
            account: ProviderAccountRecord {
                id: "acc-1".to_string(),
                provider_id: "kimi".to_string(),
                label: "kimi".to_string(),
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

    fn ids(models: &[FetchedModel]) -> Vec<&str> {
        models.iter().map(|model| model.id.as_str()).collect()
    }

    /// `kimi-models.test.ts`: an empty remote list still yields
    /// `kimi-for-coding` from the catalog defaults.
    #[tokio::test]
    async fn an_empty_remote_list_still_contains_the_seed_model() {
        let transport = StubTransport::new(models_response(StatusCode::OK, r#"{"data":[]}"#));
        let models = fetch_models(
            &*transport,
            "sk-kimi-test",
            &["kimi-for-coding".to_string()],
        )
        .await;

        assert!(
            ids(&models).contains(&"kimi-for-coding"),
            "{:?}",
            ids(&models)
        );
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].name, "kimi-for-coding");
        assert_eq!(models[0].provider, "kimi");

        let seen = transport.seen.lock().expect("lock");
        assert_eq!(seen[0].url, "https://api.kimi.com/coding/v1/models");
        assert_eq!(
            seen[0].headers.get("authorization").expect("auth header"),
            "Bearer sk-kimi-test"
        );
    }

    /// Remote ids come first and are not duplicated by the seed list.
    #[tokio::test]
    async fn remote_models_are_merged_ahead_of_the_seed_list() {
        let transport = StubTransport::new(models_response(
            StatusCode::OK,
            r#"{"data":[{"id":"kimi-for-coding"},{"id":"kimi-k2"}]}"#,
        ));
        let models = fetch_models(&*transport, "sk", &["kimi-for-coding".to_string()]).await;
        assert_eq!(ids(&models), vec!["kimi-for-coding", "kimi-k2"]);
    }

    /// `.catch(() => [])`: a transport failure degrades to the seed list instead
    /// of failing `fetchModels`.
    #[tokio::test]
    async fn a_transport_failure_degrades_to_the_seed_list() {
        let models = fetch_models(
            &crate::model_hub::http::UnreachableTransport,
            "sk",
            &["kimi-for-coding".to_string()],
        )
        .await;
        assert_eq!(ids(&models), vec!["kimi-for-coding"]);
    }

    /// An empty catalog list falls back to the hard-coded seed.
    #[tokio::test]
    async fn an_empty_catalog_list_uses_the_hard_coded_seed() {
        let transport = StubTransport::new(models_response(StatusCode::FORBIDDEN, "denied"));
        let models = fetch_models(&*transport, "sk", &[]).await;
        assert_eq!(ids(&models), vec!["kimi-for-coding"]);
    }

    /// An entry without `id` is dropped, mirroring `if (!model?.id) continue`.
    #[test]
    fn merge_unique_models_drops_empty_ids() {
        let primary = vec![FetchedModel {
            id: String::new(),
            name: "nameless".to_string(),
            provider: "kimi".to_string(),
            owned_by: None,
            context_window: None,
            created: None,
            billing: None,
        }];
        let merged = merge_unique_models(
            primary,
            map_default_models(&["kimi-for-coding".to_string()]),
        );
        assert_eq!(ids(&merged), vec!["kimi-for-coding"]);
    }

    /// The happy path passes the shared message through unchanged.
    #[tokio::test]
    async fn connectivity_reports_the_shared_success_message() {
        let transport = StubTransport::new(models_response(StatusCode::OK, r#"{"data":[]}"#));
        let env = EnvOverrides::new();
        let result = KimiAdapter
            .test_connectivity(&context("sk-kimi"), &call(&transport, &env), None)
            .await;
        assert!(result.ok);
        assert_eq!(result.message, CONNECTIVITY_OK);
    }

    /// An `invalid_authentication_error` body is rewritten to the Kimi Code key
    /// hint (`kimi/index.ts:50-57`).
    #[tokio::test]
    async fn an_authentication_error_is_rewritten_to_the_key_hint() {
        let transport = StubTransport::new(models_response(
            StatusCode::UNAUTHORIZED,
            "invalid_authentication_error",
        ));
        let env = EnvOverrides::new();
        let result = KimiAdapter
            .test_connectivity(&context("sk-wrong"), &call(&transport, &env), None)
            .await;
        assert!(!result.ok);
        assert_eq!(result.message, INVALID_AUTHENTICATION_HINT);
    }

    /// A different failure keeps the generic prefix.
    #[tokio::test]
    async fn an_unrelated_failure_keeps_the_generic_message() {
        let transport = StubTransport::new(models_response(StatusCode::FORBIDDEN, "denied"));
        let env = EnvOverrides::new();
        let result = KimiAdapter
            .test_connectivity(&context("sk"), &call(&transport, &env), None)
            .await;
        assert!(!result.ok);
        assert_eq!(result.message, "Kimi connectivity failed: denied");
    }

    /// The dispatch body is byte-identical to the other seven providers,
    /// including the `kimi` provider id and the hard-coded base URL.
    #[tokio::test]
    async fn dispatch_posts_to_the_kimi_base_url() {
        let transport = StubTransport::new(models_response(
            StatusCode::OK,
            r#"{"choices":[{"message":{"content":"ok"}}],"model":"kimi-for-coding"}"#,
        ));
        let env = EnvOverrides::new();
        let response = KimiAdapter
            .dispatch_gateway(
                &context("sk-kimi"),
                &call(&transport, &env),
                &GatewayRequest::new("kimi-for-coding", vec![GatewayMessage::user("hi")]),
                &DispatchOptions::default(),
            )
            .await
            .expect("dispatch");

        assert!(response.ok);
        assert_eq!(response.provider, "kimi");
        let seen = transport.seen.lock().expect("lock");
        assert_eq!(
            seen[0].url,
            "https://api.kimi.com/coding/v1/chat/completions"
        );
        assert_eq!(
            seen[0].body.as_deref().expect("body"),
            r#"{"model":"kimi-for-coding","messages":[{"role":"user","content":"hi"}],"max_tokens":4096,"temperature":0.7,"stream":false}"#
        );
    }
}
