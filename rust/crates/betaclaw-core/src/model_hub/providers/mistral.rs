//! Port of `src/server/model-hub/Models/mistral/index.ts`.
//!
//! Identical shape to the OpenAI adapter: `endpointType` is `mistral-native` in
//! the catalog, but `dispatchGateway` still goes through the shared
//! OpenAI-compatible layer, because Mistral exposes `/v1/chat/completions`.

use crate::model_hub::http::{BoxFuture, HttpError};
use crate::model_hub::openai_compatible::{
    dispatch_openai_compatible_chat, fetch_openai_compatible_models,
    test_openai_compatible_models_endpoint, DispatchOptions,
};
use crate::model_hub::types::{
    ConnectivityResult, FetchedModel, GatewayRequest, GatewayResponse, ProviderExecutionContext,
};

use super::{ProviderAdapter, ProviderCall};

/// `https://api.mistral.ai/v1` from `mistral/index.ts:10`.
pub const BASE_URL: &str = "https://api.mistral.ai/v1";
/// `Mistral connectivity verified (models list reachable).` from `mistral/index.ts:15`.
pub const CONNECTIVITY_OK: &str = "Mistral connectivity verified (models list reachable).";
/// `Mistral connectivity failed: ` from `mistral/index.ts:16`.
pub const CONNECTIVITY_FAILURE_PREFIX: &str = "Mistral connectivity failed: ";

/// `mistralProviderAdapter` from `mistral/index.ts:7-23`.
#[derive(Debug, Clone, Copy, Default)]
pub struct MistralAdapter;

impl ProviderAdapter for MistralAdapter {
    fn id(&self) -> &'static str {
        "mistral"
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
            provider: find_provider("mistral")
                .expect("mistral is in the catalog")
                .clone(),
            account: ProviderAccountRecord {
                id: "mistral".to_string(),
                provider_id: "mistral".to_string(),
                label: "mistral".to_string(),
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

    /// `mistral/index.ts:10-11`: the models base is hard-coded to
    /// `https://api.mistral.ai/v1` and `'mistral'` is the mapped `provider`.
    #[tokio::test]
    async fn fetch_models_targets_the_mistral_models_endpoint() {
        let transport = StubTransport::new(HttpResponse::json(
            StatusCode::OK,
            &json!({ "data": [{ "id": "mistral-large-latest" }] }),
        ));

        let models = MistralAdapter
            .fetch_models(
                &context("sk-mistral"),
                &call(&transport, &EnvOverrides::new()),
            )
            .await
            .expect("fetch");

        assert_eq!(models.len(), 1);
        assert_eq!(models[0].provider, "mistral");
        let seen = transport.seen();
        assert_eq!(seen[0].method, http::Method::GET);
        assert_eq!(seen[0].url, "https://api.mistral.ai/v1/models");
        assert_eq!(
            seen[0].headers.get("authorization").expect("auth header"),
            "Bearer sk-mistral"
        );
    }

    /// `mistral/index.ts:12-18` declares `testConnectivity` as `({ secret }) => …`
    /// and never reads `options`, so the probe stays on the models endpoint even
    /// when a model is requested.
    #[tokio::test]
    async fn connectivity_ignores_a_requested_model_and_probes_the_models_endpoint() {
        let transport =
            StubTransport::new(HttpResponse::json(StatusCode::OK, &json!({ "data": [] })));

        let result = MistralAdapter
            .test_connectivity(
                &context("sk-mistral"),
                &call(&transport, &EnvOverrides::new()),
                Some("ministral-8b-latest"),
            )
            .await;

        assert!(result.ok);
        assert_eq!(result.message, CONNECTIVITY_OK);
        assert_eq!(
            transport.seen()[0].url,
            "https://api.mistral.ai/v1/models",
            "options.model is not a Mistral probe target (mistral/index.ts:12)"
        );
    }

    /// `mistral/index.ts:16-18`: the Mistral-specific failure prefix with the
    /// trailing space; the reason is the `await response.text()` of the shared
    /// models endpoint (`models/fetch.ts:43-48`).
    #[tokio::test]
    async fn connectivity_failure_uses_the_mistral_prefix() {
        let transport =
            StubTransport::new(HttpResponse::text(StatusCode::UNAUTHORIZED, "Unauthorized"));

        let result = MistralAdapter
            .test_connectivity(
                &context("sk-bad"),
                &call(&transport, &EnvOverrides::new()),
                None,
            )
            .await;

        assert!(!result.ok);
        assert_eq!(result.message, "Mistral connectivity failed: Unauthorized");
    }

    /// `mistral/index.ts:19-23`: the catalog types Mistral as `mistral-native`
    /// (`providerCatalog.ts` / `provider_catalog.rs:206`), yet the adapter still
    /// dispatches through the shared OpenAI-compatible layer — `POST
    /// https://api.mistral.ai/v1/chat/completions` with `providerId = 'mistral'`
    /// and no provider-specific headers.
    #[tokio::test]
    async fn dispatch_posts_to_the_shared_openai_compatible_chat_endpoint() {
        let transport = StubTransport::new(HttpResponse::json(
            StatusCode::OK,
            &json!({
                "choices": [{ "message": { "content": "pong" } }],
                "model": "mistral-large-latest"
            }),
        ));

        let response = MistralAdapter
            .dispatch_gateway(
                &context("sk-mistral"),
                &call(&transport, &EnvOverrides::new()),
                &GatewayRequest::new("mistral-large-latest", vec![GatewayMessage::user("ping")]),
                &DispatchOptions::default(),
            )
            .await
            .expect("dispatch");

        assert!(response.ok);
        assert_eq!(response.provider, "mistral");
        assert_eq!(response.text, "pong");
        let seen = transport.seen();
        assert_eq!(seen[0].method, http::Method::POST);
        assert_eq!(seen[0].url, "https://api.mistral.ai/v1/chat/completions");
        assert!(seen[0].headers.get("http-referer").is_none());
    }
}
