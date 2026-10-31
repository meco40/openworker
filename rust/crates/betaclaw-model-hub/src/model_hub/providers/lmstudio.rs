//! Port of `src/server/model-hub/Models/lmstudio/index.ts`.
//!
//! The only local provider in S4a: its base URL comes from `LMSTUDIO_BASE_URL`
//! instead of being hard-coded, and the trailing slash is stripped — twice, once
//! in `lmStudioBaseUrl()` and again inside `buildModelsUrl`/`buildChatUrl`.

use crate::model_hub::http::{BoxFuture, HttpError};
use crate::model_hub::openai_compatible::{
    dispatch_openai_compatible_chat, fetch_openai_compatible_models, normalize_base_url,
    test_openai_compatible_models_endpoint, DispatchOptions,
};
use crate::model_hub::types::{
    ConnectivityResult, FetchedModel, GatewayRequest, GatewayResponse, ProviderExecutionContext,
};

use super::{ProviderAdapter, ProviderCall};

/// `http://localhost:1234/v1` from `lmstudio/index.ts:7`.
pub const DEFAULT_BASE_URL: &str = "http://localhost:1234/v1";
/// `LM Studio connectivity verified.` from `lmstudio/index.ts:18`.
pub const CONNECTIVITY_OK: &str = "LM Studio connectivity verified.";
/// `LM Studio connectivity failed: ` from `lmstudio/index.ts:19`.
pub const CONNECTIVITY_FAILURE_PREFIX: &str = "LM Studio connectivity failed: ";

/// `lmStudioBaseUrl` from `lmstudio/index.ts:7`:
/// `(process.env.LMSTUDIO_BASE_URL || 'http://localhost:1234/v1').replace(/\/$/, '')`.
pub fn base_url(env: &super::super::env::EnvOverrides) -> String {
    normalize_base_url(&env.get_or("LMSTUDIO_BASE_URL", DEFAULT_BASE_URL))
}

/// `lmStudioProviderAdapter` from `lmstudio/index.ts:9-25`.
#[derive(Debug, Clone, Copy, Default)]
pub struct LmStudioAdapter;

impl ProviderAdapter for LmStudioAdapter {
    fn id(&self) -> &'static str {
        "lmstudio"
    }

    fn fetch_models<'a>(
        &'a self,
        context: &'a ProviderExecutionContext,
        call: &'a ProviderCall<'_>,
    ) -> BoxFuture<'a, Result<Vec<FetchedModel>, HttpError>> {
        Box::pin(async move {
            fetch_openai_compatible_models(
                call.transport,
                &base_url(call.env),
                &context.secret,
                self.id(),
            )
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
                &base_url(call.env),
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
                &base_url(call.env),
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
            provider: find_provider("lmstudio")
                .expect("lmstudio is in the catalog")
                .clone(),
            account: ProviderAccountRecord {
                id: "lmstudio".to_string(),
                provider_id: "lmstudio".to_string(),
                label: "lmstudio".to_string(),
                auth_method: ProviderAuthMethod::None,
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

    /// `lmstudio/index.ts:9`: `process.env.LMSTUDIO_BASE_URL || 'http://localhost:1234/v1'`.
    /// JavaScript's `||` treats the empty string as absent, so an empty variable
    /// still yields the local default.
    #[test]
    fn an_empty_variable_falls_back_to_the_localhost_default() {
        assert_eq!(DEFAULT_BASE_URL, "http://localhost:1234/v1");
        let env = EnvOverrides::new().with("LMSTUDIO_BASE_URL", "");
        assert_eq!(base_url(&env), "http://localhost:1234/v1");
    }

    /// `lmstudio/index.ts:9` strips one trailing slash, and
    /// `buildModelsUrl`/`buildChatUrl` strip another one through the shared
    /// `normalizeBaseUrl` (`utils.ts:46-52`). Two slashes in the variable are
    /// therefore consumed before `/models` is appended.
    #[tokio::test]
    async fn a_trailing_slash_is_stripped_twice() {
        let env = EnvOverrides::new().with("LMSTUDIO_BASE_URL", "http://localhost:1234/v1//");
        assert_eq!(base_url(&env), "http://localhost:1234/v1/");

        let transport = StubTransport::new(HttpResponse::json(
            StatusCode::OK,
            &json!({ "data": [{ "id": "qwen2.5-coder-7b-instruct" }] }),
        ));
        let models = LmStudioAdapter
            .fetch_models(&context(""), &call(&transport, &env))
            .await
            .expect("fetch");

        assert_eq!(models[0].provider, "lmstudio");
        assert_eq!(
            transport.seen()[0].url,
            "http://localhost:1234/v1/models",
            "one slash by lmStudioBaseUrl, one by buildModelsUrl"
        );
    }

    /// `lmstudio/index.ts:14`: `fetchModels` reads `LMSTUDIO_BASE_URL` at call
    /// time and nothing else — the variable is the only provider-specific input.
    #[tokio::test]
    async fn fetch_models_uses_the_configured_base_url() {
        let env = EnvOverrides::new().with("LMSTUDIO_BASE_URL", "http://127.0.0.1:4321/v1");
        let transport = StubTransport::new(HttpResponse::json(
            StatusCode::OK,
            &json!({ "data": [{ "id": "qwen2.5-coder-7b-instruct" }] }),
        ));

        let models = LmStudioAdapter
            .fetch_models(&context("sk-local"), &call(&transport, &env))
            .await
            .expect("fetch");

        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "qwen2.5-coder-7b-instruct");
        assert_eq!(models[0].provider, "lmstudio");
        let seen = transport.seen();
        assert_eq!(seen[0].method, http::Method::GET);
        assert_eq!(seen[0].url, "http://127.0.0.1:4321/v1/models");
    }

    /// `lmstudio/index.ts:15-21`: the probe is the shared models endpoint with the
    /// two LM Studio strings, and `options` is ignored, so a requested model never
    /// becomes the probe target.
    #[tokio::test]
    async fn connectivity_probes_the_models_endpoint_and_ignores_a_requested_model() {
        let env = EnvOverrides::new().with("LMSTUDIO_BASE_URL", "http://127.0.0.1:4321/v1");
        let transport =
            StubTransport::new(HttpResponse::json(StatusCode::OK, &json!({ "data": [] })));

        let result = LmStudioAdapter
            .test_connectivity(
                &context(""),
                &call(&transport, &env),
                Some("qwen2.5-coder-7b-instruct"),
            )
            .await;

        assert!(result.ok);
        assert_eq!(result.message, CONNECTIVITY_OK);
        assert_eq!(transport.seen()[0].url, "http://127.0.0.1:4321/v1/models");
    }

    /// `lmstudio/index.ts:20`: the LM Studio failure prefix; the reason is the
    /// `HTTP <status>` fallback of an empty body (`models/fetch.ts`).
    #[tokio::test]
    async fn connectivity_failure_uses_the_lm_studio_prefix() {
        let env = EnvOverrides::new().with("LMSTUDIO_BASE_URL", "http://127.0.0.1:4321/v1");
        let transport =
            StubTransport::new(HttpResponse::text(StatusCode::INTERNAL_SERVER_ERROR, ""));

        let result = LmStudioAdapter
            .test_connectivity(&context(""), &call(&transport, &env), None)
            .await;

        assert!(!result.ok);
        assert_eq!(
            result.message,
            "LM Studio connectivity failed: HTTP 500".to_string()
        );
    }

    /// `lmstudio/index.ts:22-26` plus the catalog entry: LM Studio is the local
    /// provider that allows `authMethods: ['none', 'api_key']`
    /// (`provider_catalog.rs:183`), so an empty secret must produce a chat request
    /// without an `Authorization` header at all (`utils.ts:15-19`).
    #[tokio::test]
    async fn dispatch_posts_to_the_configured_base_url_and_omits_the_auth_header_for_no_auth() {
        let env = EnvOverrides::new().with("LMSTUDIO_BASE_URL", "http://127.0.0.1:4321/v1");
        let transport = StubTransport::new(HttpResponse::json(
            StatusCode::OK,
            &json!({
                "choices": [{ "message": { "content": "ok" } }],
                "model": "qwen2.5-coder-7b-instruct"
            }),
        ));

        let response = LmStudioAdapter
            .dispatch_gateway(
                &context(""),
                &call(&transport, &env),
                &GatewayRequest::new(
                    "qwen2.5-coder-7b-instruct",
                    vec![GatewayMessage::user("hi")],
                ),
                &DispatchOptions::default(),
            )
            .await
            .expect("dispatch");

        assert!(response.ok);
        assert_eq!(response.provider, "lmstudio");
        let seen = transport.seen();
        assert_eq!(seen[0].method, http::Method::POST);
        assert_eq!(seen[0].url, "http://127.0.0.1:4321/v1/chat/completions");
        assert!(seen[0].headers.get("authorization").is_none());
    }
}
