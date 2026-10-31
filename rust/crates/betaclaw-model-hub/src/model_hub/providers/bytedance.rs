//! Port of `src/server/model-hub/Models/bytedance/index.ts`.
//!
//! The only adapter with **no** `fetchModels` network call: ByteDance's ModelArk
//! does not expose a models endpoint through the OpenAI-compatible API, so the
//! adapter answers from a hard-coded list that includes one model absent from the
//! catalog's `defaultModels` (`doubao-1-5-pro-256k-250115`).
//!
//! Like Z.AI, the connectivity ping sends `Bearer ${secret}` raw and posts to
//! `chat/completions`.

use serde_json::Value;

use crate::model_hub::http::{
    fetch_json_ok, BoxFuture, HttpError, HttpRequest, DEFAULT_REQUEST_TIMEOUT_MS,
};
use crate::model_hub::openai_compatible::{dispatch_openai_compatible_chat, DispatchOptions};
use crate::model_hub::providers::default_model_or_first;
use crate::model_hub::types::{
    ConnectivityResult, FetchedModel, GatewayRequest, GatewayResponse, ProviderExecutionContext,
};

use super::{ProviderAdapter, ProviderCall};

/// `https://ark.cn-beijing.volces.com/api/v3` from `bytedance/index.ts:31`.
pub const BASE_URL: &str = "https://ark.cn-beijing.volces.com/api/v3";
/// `ByteDance test requires a model/endpoint id.` from `bytedance/index.ts:19`.
pub const MISSING_MODEL: &str = "ByteDance test requires a model/endpoint id.";
/// `ByteDance ModelArk connectivity verified.` from `bytedance/index.ts:35`.
pub const CONNECTIVITY_OK: &str = "ByteDance ModelArk connectivity verified.";
/// `ByteDance connectivity failed: ` from `bytedance/index.ts:36`.
pub const CONNECTIVITY_FAILURE_PREFIX: &str = "ByteDance connectivity failed: ";

/// The hard-coded model list from `bytedance/index.ts:9-13`.
pub const STATIC_MODELS: &[(&str, &str)] = &[
    ("doubao-1-5-lite-32k-250115", "Doubao 1.5 Lite 32K"),
    ("doubao-1-5-pro-32k-250115", "Doubao 1.5 Pro 32K"),
    ("doubao-1-5-pro-256k-250115", "Doubao 1.5 Pro 256K"),
];

/// The ping body from `bytedance/index.ts:28-32`.
pub fn ping_body(model: &str) -> Value {
    serde_json::json!({
        "model": model,
        "messages": [{ "role": "user", "content": "ping" }],
        "max_tokens": 4,
    })
}

/// `bytedanceProviderAdapter` from `bytedance/index.ts:5-38`.
#[derive(Debug, Clone, Copy, Default)]
pub struct BytedanceAdapter;

impl ProviderAdapter for BytedanceAdapter {
    fn id(&self) -> &'static str {
        "bytedance"
    }

    /// Always succeeds — the TypeScript adapter declares no `fetchModels`
    /// rejection path.
    fn fetch_models<'a>(
        &'a self,
        _context: &'a ProviderExecutionContext,
        _call: &'a ProviderCall<'_>,
    ) -> BoxFuture<'a, Result<Vec<FetchedModel>, HttpError>> {
        Box::pin(async move {
            Ok(STATIC_MODELS
                .iter()
                .map(|(id, name)| FetchedModel {
                    id: (*id).to_string(),
                    name: (*name).to_string(),
                    provider: "bytedance".to_string(),
                    owned_by: None,
                    context_window: None,
                    created: None,
                    billing: None,
                })
                .collect())
        })
    }

    fn test_connectivity<'a>(
        &'a self,
        context: &'a ProviderExecutionContext,
        call: &'a ProviderCall<'_>,
        model: Option<&'a str>,
    ) -> BoxFuture<'a, ConnectivityResult> {
        Box::pin(async move {
            let model = match model.or_else(|| default_model_or_first(context)) {
                Some(model) => model.to_string(),
                None => return ConnectivityResult::failed(MISSING_MODEL),
            };

            let request = HttpRequest::post(format!("{BASE_URL}/chat/completions"))
                .header("Authorization", &format!("Bearer {}", context.secret))
                .header("Content-Type", "application/json")
                .json_body(&ping_body(&model));

            match fetch_json_ok(call.transport, request, DEFAULT_REQUEST_TIMEOUT_MS).await {
                crate::model_hub::http::JsonOkResult::Ok(_) => {
                    ConnectivityResult::ok(CONNECTIVITY_OK)
                }
                crate::model_hub::http::JsonOkResult::Err(message) => {
                    ConnectivityResult::failed(format!("{CONNECTIVITY_FAILURE_PREFIX}{message}"))
                }
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
    use std::sync::Mutex;

    use http::StatusCode;
    use serde_json::json;

    use super::*;
    use crate::model_hub::env::EnvOverrides;
    use crate::model_hub::http::{HttpRequest, HttpResponse, HttpTransport, UnreachableTransport};
    use crate::model_hub::openai_compatible::NOOP_ATTACHMENT_STORE;
    use crate::model_hub::provider_catalog::find_provider;
    use crate::model_hub::repository::encrypted_secret_input;
    use crate::model_hub::types::{GatewayMessage, ProviderAccountRecord, ProviderAuthMethod};

    /// One canned reply plus every request the adapter issued.
    struct StubTransport {
        response: HttpResponse,
        seen: Mutex<Vec<HttpRequest>>,
    }

    impl StubTransport {
        fn new(response: HttpResponse) -> Self {
            Self {
                response,
                seen: Mutex::new(Vec::new()),
            }
        }

        fn seen(&self) -> Vec<HttpRequest> {
            self.seen.lock().expect("lock").clone()
        }
    }

    impl HttpTransport for StubTransport {
        fn send<'a>(
            &'a self,
            request: HttpRequest,
        ) -> BoxFuture<'a, Result<HttpResponse, HttpError>> {
            self.seen.lock().expect("lock").push(request);
            let response = self.response.clone();
            Box::pin(async move { Ok(response) })
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
            provider: find_provider("bytedance")
                .expect("bytedance is in the catalog")
                .clone(),
            account: ProviderAccountRecord {
                id: "bytedance".to_string(),
                provider_id: "bytedance".to_string(),
                label: "bytedance".to_string(),
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

    /// `bytedance/index.ts:8-14`: `fetchModels` takes no arguments and returns a
    /// hard-coded list — no `fetch`, no transport, no `context` read. ByteDance
    /// ModelArk exposes no models endpoint, so the transport must stay untouched.
    #[tokio::test]
    async fn fetch_models_returns_the_hard_coded_list_without_a_network_call() {
        let transport = StubTransport::new(HttpResponse::json(StatusCode::OK, &json!({})));

        let models = BytedanceAdapter
            .fetch_models(&context("sk-ark"), &call(&transport, &EnvOverrides::new()))
            .await
            .expect("fetch");

        assert_eq!(
            models
                .iter()
                .map(|model| (
                    model.id.as_str(),
                    model.name.as_str(),
                    model.provider.as_str()
                ))
                .collect::<Vec<_>>(),
            vec![
                (
                    "doubao-1-5-lite-32k-250115",
                    "Doubao 1.5 Lite 32K",
                    "bytedance"
                ),
                (
                    "doubao-1-5-pro-32k-250115",
                    "Doubao 1.5 Pro 32K",
                    "bytedance"
                ),
                (
                    "doubao-1-5-pro-256k-250115",
                    "Doubao 1.5 Pro 256K",
                    "bytedance"
                ),
            ]
        );
        assert!(
            transport.seen().is_empty(),
            "bytedance/index.ts:8-14 never calls fetch"
        );
    }

    /// The hard-coded list is *not* the catalog defaults: the 256K variant is
    /// offered by the adapter (`bytedance/index.ts:12`) but absent from
    /// `PROVIDER_CATALOG.bytedance.defaultModels` (`provider_catalog.rs:252` /
    /// `providerCatalog.ts`), while it is the first default the ping falls back to.
    #[tokio::test]
    async fn fetch_models_offers_a_model_the_catalog_defaults_do_not_list() {
        let context = context("sk-ark");
        let transport = StubTransport::new(HttpResponse::json(StatusCode::OK, &json!({})));

        let models = BytedanceAdapter
            .fetch_models(&context, &call(&transport, &EnvOverrides::new()))
            .await
            .expect("fetch");

        let ids: Vec<&str> = models.iter().map(|model| model.id.as_str()).collect();
        assert!(ids.contains(&"doubao-1-5-pro-256k-250115"));
        assert!(!context
            .provider
            .default_models
            .iter()
            .any(|id| id == "doubao-1-5-pro-256k-250115"));
        assert_eq!(
            context.provider.default_models[0],
            "doubao-1-5-lite-32k-250115"
        );
    }

    /// `bytedance/index.ts:22-32`: the probe is a `chat/completions` POST with the
    /// `{ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 4 }`
    /// literal — `max_tokens: 4`, not the shared dispatch default. Line 25
    /// interpolates `secret` verbatim, so a quoted secret arrives with its quotes
    /// (the shared layer would have stripped them).
    #[tokio::test]
    async fn connectivity_posts_the_ping_literal_and_the_raw_secret() {
        let transport = StubTransport::new(HttpResponse::json(
            StatusCode::OK,
            &json!({ "choices": [{ "message": { "content": "pong" } }] }),
        ));

        let result = BytedanceAdapter
            .test_connectivity(
                &context("\"sk-ark\""),
                &call(&transport, &EnvOverrides::new()),
                Some("ep-20250101-abc"),
            )
            .await;

        assert!(result.ok);
        assert_eq!(result.message, CONNECTIVITY_OK);
        let seen = transport.seen();
        assert_eq!(seen[0].method, http::Method::POST);
        assert_eq!(
            seen[0].url,
            "https://ark.cn-beijing.volces.com/api/v3/chat/completions"
        );
        assert_eq!(
            seen[0].headers.get("authorization").expect("auth header"),
            "Bearer \"sk-ark\"",
            "bytedance/index.ts:25 interpolates the secret verbatim"
        );
        assert_eq!(
            seen[0].body.as_deref().expect("body"),
            r#"{"model":"ep-20250101-abc","messages":[{"role":"user","content":"ping"}],"max_tokens":4}"#
        );
    }

    /// `bytedance/index.ts:17`: `options.model || provider.defaultModels[0]` — with
    /// no model requested the ping uses the first catalog default.
    #[tokio::test]
    async fn connectivity_falls_back_to_the_first_catalog_default_model() {
        let transport = StubTransport::new(HttpResponse::json(
            StatusCode::OK,
            &json!({ "choices": [{ "message": { "content": "pong" } }] }),
        ));

        let result = BytedanceAdapter
            .test_connectivity(
                &context("sk-ark"),
                &call(&transport, &EnvOverrides::new()),
                None,
            )
            .await;

        assert!(result.ok);
        assert_eq!(
            transport.seen()[0].body.as_deref().expect("body"),
            r#"{"model":"doubao-1-5-lite-32k-250115","messages":[{"role":"user","content":"ping"}],"max_tokens":4}"#
        );
    }

    /// `bytedance/index.ts:18-20`: with neither an explicit model/endpoint id nor a
    /// catalog default the adapter returns the literal message and issues no
    /// request — `UnreachableTransport` would surface a transport error if it did.
    #[tokio::test]
    async fn connectivity_without_any_model_reports_the_missing_model_message() {
        let mut context = context("sk-ark");
        context.provider.default_models.clear();

        let result = BytedanceAdapter
            .test_connectivity(
                &context,
                &call(&UnreachableTransport, &EnvOverrides::new()),
                None,
            )
            .await;

        assert!(!result.ok);
        assert_eq!(result.message, MISSING_MODEL);
    }

    /// `bytedance/index.ts:37`: `ByteDance connectivity failed: ` plus the
    /// `fetchJsonOk` reason — the non-JSON text branch of `parseErrorMessage`
    /// (`shared/http.ts:64-67`).
    #[tokio::test]
    async fn connectivity_failure_uses_the_bytedance_prefix() {
        let transport = StubTransport::new(HttpResponse::text(
            StatusCode::FORBIDDEN,
            "Invalid endpoint",
        ));

        let result = BytedanceAdapter
            .test_connectivity(
                &context("sk-bad"),
                &call(&transport, &EnvOverrides::new()),
                Some("ep-does-not-exist"),
            )
            .await;

        assert!(!result.ok);
        assert_eq!(
            result.message,
            "ByteDance connectivity failed: Invalid endpoint"
        );
    }

    /// `bytedance/index.ts:40-47`: dispatch goes through the shared
    /// OpenAI-compatible layer with the Ark base URL and `providerId =
    /// 'bytedance'`, so the chat body carries the shared defaults (`max_tokens`
    /// 4096) instead of the ping's `max_tokens: 4`.
    #[tokio::test]
    async fn dispatch_posts_to_the_ark_base_url_through_the_shared_layer() {
        let transport = StubTransport::new(HttpResponse::json(
            StatusCode::OK,
            &json!({ "choices": [{ "message": { "content": "ok" } }], "model": "doubao-1-5-pro-32k-250115" }),
        ));

        let response = BytedanceAdapter
            .dispatch_gateway(
                &context("sk-ark"),
                &call(&transport, &EnvOverrides::new()),
                &GatewayRequest::new(
                    "doubao-1-5-pro-32k-250115",
                    vec![GatewayMessage::user("hi")],
                ),
                &DispatchOptions::default(),
            )
            .await
            .expect("dispatch");

        assert!(response.ok);
        assert_eq!(response.provider, "bytedance");
        let seen = transport.seen();
        assert_eq!(seen[0].method, http::Method::POST);
        assert_eq!(
            seen[0].url,
            "https://ark.cn-beijing.volces.com/api/v3/chat/completions"
        );
        assert_eq!(
            seen[0].body.as_deref().expect("body"),
            r#"{"model":"doubao-1-5-pro-32k-250115","messages":[{"role":"user","content":"hi"}],"max_tokens":4096,"temperature":0.7,"stream":false}"#
        );
    }
}
