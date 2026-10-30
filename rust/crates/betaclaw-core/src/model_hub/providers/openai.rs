//! Port of `src/server/model-hub/Models/openai/index.ts`.
//!
//! A pure delegation to the shared OpenAI-compatible layer: one base URL and two
//! connectivity strings.

use crate::model_hub::http::{BoxFuture, HttpError};
use crate::model_hub::openai_compatible::{
    dispatch_openai_compatible_chat, fetch_openai_compatible_models,
    test_openai_compatible_models_endpoint, DispatchOptions,
};
use crate::model_hub::types::{
    ConnectivityResult, FetchedModel, GatewayRequest, GatewayResponse, ProviderExecutionContext,
};

use super::{ProviderAdapter, ProviderCall};

/// `https://api.openai.com/v1` from `openai/index.ts:10`.
pub const BASE_URL: &str = "https://api.openai.com/v1";
/// `OpenAI connectivity verified (models list reachable).` from `openai/index.ts:15`.
pub const CONNECTIVITY_OK: &str = "OpenAI connectivity verified (models list reachable).";
/// `OpenAI connectivity failed: ` from `openai/index.ts:16`.
pub const CONNECTIVITY_FAILURE_PREFIX: &str = "OpenAI connectivity failed: ";

/// `openAIProviderAdapter` from `openai/index.ts:7-23`.
#[derive(Debug, Clone, Copy, Default)]
pub struct OpenAiAdapter;

impl ProviderAdapter for OpenAiAdapter {
    fn id(&self) -> &'static str {
        "openai"
    }

    fn fetch_models<'a>(
        &'a self,
        context: &'a ProviderExecutionContext,
        call: &'a ProviderCall<'_>,
    ) -> BoxFuture<'a, Result<Vec<FetchedModel>, HttpError>> {
        Box::pin(async move {
            fetch_openai_compatible_models(call.transport, BASE_URL, &context.secret, self.id())
                .await
        })
    }

    fn test_connectivity<'a>(
        &'a self,
        context: &'a ProviderExecutionContext,
        call: &'a ProviderCall<'_>,
        _model: Option<&'a str>,
    ) -> BoxFuture<'a, ConnectivityResult> {
        // The TypeScript adapter ignores `options.model`; it always probes the
        // models endpoint.
        Box::pin(async move {
            test_openai_compatible_models_endpoint(
                call.transport,
                BASE_URL,
                &context.secret,
                CONNECTIVITY_OK,
                CONNECTIVITY_FAILURE_PREFIX,
            )
            .await
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
    use crate::model_hub::http::{HttpRequest, HttpResponse, HttpTransport};
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
            provider: find_provider("openai")
                .expect("openai is in the catalog")
                .clone(),
            account: ProviderAccountRecord {
                id: "openai".to_string(),
                provider_id: "openai".to_string(),
                label: "openai".to_string(),
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

    /// `openai/index.ts:10-11`: the adapter hard-codes `https://api.openai.com/v1`
    /// as the models base and passes `'openai'` as the mapped `provider` of every
    /// entry, so both values are visible in the request and in the result.
    #[tokio::test]
    async fn fetch_models_targets_the_openai_models_endpoint() {
        let transport = StubTransport::new(HttpResponse::json(
            StatusCode::OK,
            &json!({ "data": [{ "id": "gpt-4o-mini", "owned_by": "openai" }] }),
        ));

        let models = OpenAiAdapter
            .fetch_models(
                &context("sk-openai"),
                &call(&transport, &EnvOverrides::new()),
            )
            .await
            .expect("fetch");

        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "gpt-4o-mini");
        assert_eq!(models[0].provider, "openai");
        assert_eq!(models[0].owned_by.as_deref(), Some("openai"));
        let seen = transport.seen();
        assert_eq!(seen[0].method, http::Method::GET);
        assert_eq!(seen[0].url, "https://api.openai.com/v1/models");
        assert_eq!(
            seen[0].headers.get("authorization").expect("auth header"),
            "Bearer sk-openai"
        );
    }

    /// `openai/index.ts:12-18` declares `testConnectivity` as `({ secret }) => …`
    /// and never reads `options`, so a requested model must not become the probe
    /// target — the shared models endpoint is the only probe this adapter has.
    #[tokio::test]
    async fn connectivity_ignores_a_requested_model_and_probes_the_models_endpoint() {
        let transport = StubTransport::new(HttpResponse::json(
            StatusCode::OK,
            &json!({ "data": [{ "id": "gpt-4o-mini" }] }),
        ));

        let result = OpenAiAdapter
            .test_connectivity(
                &context("sk-openai"),
                &call(&transport, &EnvOverrides::new()),
                Some("gpt-4o-mini"),
            )
            .await;

        assert!(result.ok);
        assert_eq!(result.message, CONNECTIVITY_OK);
        assert_eq!(
            transport.seen()[0].url,
            "https://api.openai.com/v1/models",
            "options.model is not an OpenAI probe target (openai/index.ts:12)"
        );
    }

    /// `openai/index.ts:16-18`: the failure prefix carries the trailing space; the
    /// reason is the `testOpenAICompatibleModelsEndpoint` text of
    /// `models/fetch.ts:43-48` — `await response.text()`, with `HTTP <status>` as
    /// the empty-body fallback.
    #[tokio::test]
    async fn connectivity_failure_uses_the_openai_prefix() {
        let transport = StubTransport::new(HttpResponse::text(
            StatusCode::UNAUTHORIZED,
            "Incorrect API key provided",
        ));

        let result = OpenAiAdapter
            .test_connectivity(
                &context("sk-bad"),
                &call(&transport, &EnvOverrides::new()),
                None,
            )
            .await;

        assert!(!result.ok);
        assert_eq!(
            result.message,
            "OpenAI connectivity failed: Incorrect API key provided"
        );
    }

    /// `openai/index.ts:19-23`: the dispatch call passes only `signal` and
    /// `onStreamDelta` — no `extraHeaders` object, unlike OpenRouter
    /// (`openrouter/index.ts:40-43`). The request therefore carries exactly the
    /// shared `Content-Type` and `Authorization` headers.
    #[tokio::test]
    async fn dispatch_posts_to_the_openai_chat_endpoint_without_extra_headers() {
        let transport = StubTransport::new(HttpResponse::json(
            StatusCode::OK,
            &json!({ "choices": [{ "message": { "content": "ok" } }], "model": "gpt-4o-mini" }),
        ));

        let response = OpenAiAdapter
            .dispatch_gateway(
                &context("sk-openai"),
                &call(&transport, &EnvOverrides::new()),
                &GatewayRequest::new("gpt-4o-mini", vec![GatewayMessage::user("hi")]),
                &DispatchOptions::default(),
            )
            .await
            .expect("dispatch");

        assert!(response.ok);
        assert_eq!(response.provider, "openai");
        assert_eq!(response.text, "ok");
        let seen = transport.seen();
        assert_eq!(seen[0].method, http::Method::POST);
        assert_eq!(seen[0].url, "https://api.openai.com/v1/chat/completions");
        assert_eq!(seen[0].headers.len(), 2, "{:?}", seen[0].headers);
        assert!(seen[0].headers.get("http-referer").is_none());
    }
}
