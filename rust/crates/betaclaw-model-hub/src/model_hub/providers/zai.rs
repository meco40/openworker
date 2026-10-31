//! Port of `src/server/model-hub/Models/zai/index.ts`.
//!
//! Z.AI is OpenAI-compatible for chat but its connectivity probe is a real
//! `chat/completions` ping rather than a models-list request — the models endpoint
//! is not part of the public Z.AI API.
//!
//! Note the ping uses `Bearer ${secret}` **raw**, unlike the shared header builder
//! which runs `normalizeBearerSecret` first. A stored secret that still carries a
//! `Bearer ` prefix or surrounding quotes therefore fails here while chat dispatch
//! would succeed. Ported verbatim; see the module docs in `model_hub/mod.rs`.

use serde_json::Value;

use crate::model_hub::http::{fetch_json_ok, BoxFuture, HttpError, HttpRequest};
use crate::model_hub::openai_compatible::{
    dispatch_openai_compatible_chat, fetch_openai_compatible_models, DispatchOptions,
};
use crate::model_hub::providers::default_model_or_first;
use crate::model_hub::types::{
    ConnectivityResult, FetchedModel, GatewayRequest, GatewayResponse, ProviderExecutionContext,
};

use super::{ProviderAdapter, ProviderCall};

/// `https://api.z.ai/api/paas/v4` from `zai/index.ts:15`.
pub const BASE_URL: &str = "https://api.z.ai/api/paas/v4";
/// `Z.AI test requires a model id.` from `zai/index.ts:17`.
pub const MISSING_MODEL: &str = "Z.AI test requires a model id.";
/// `Z.AI connectivity verified.` from `zai/index.ts:33`.
pub const CONNECTIVITY_OK: &str = "Z.AI connectivity verified.";
/// `Z.AI connectivity failed: ` from `zai/index.ts:34`.
pub const CONNECTIVITY_FAILURE_PREFIX: &str = "Z.AI connectivity failed: ";

/// The ping body from `zai/index.ts:26-30`.
pub fn ping_body(model: &str) -> Value {
    serde_json::json!({
        "model": model,
        "messages": [{ "role": "user", "content": "ping" }],
        "max_tokens": 4,
    })
}

/// `zaiProviderAdapter` from `zai/index.ts:9-38`.
#[derive(Debug, Clone, Copy, Default)]
pub struct ZaiAdapter;

impl ProviderAdapter for ZaiAdapter {
    fn id(&self) -> &'static str {
        "zai"
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

            match fetch_json_ok(
                call.transport,
                request,
                crate::model_hub::http::DEFAULT_REQUEST_TIMEOUT_MS,
            )
            .await
            {
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

    /// The catalog's Z.AI entry, including `defaultModels` — the ping falls back
    /// to its first element.
    fn context(secret: &str) -> ProviderExecutionContext {
        ProviderExecutionContext {
            provider: find_provider("zai").expect("zai is in the catalog").clone(),
            account: ProviderAccountRecord {
                id: "zai".to_string(),
                provider_id: "zai".to_string(),
                label: "zai".to_string(),
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

    /// `zai/index.ts:10-11`: the models base is hard-coded to
    /// `https://api.z.ai/api/paas/v4` and `'zai'` is the mapped `provider`.
    #[tokio::test]
    async fn fetch_models_targets_the_zai_models_endpoint() {
        let transport = StubTransport::new(HttpResponse::json(
            StatusCode::OK,
            &json!({ "data": [{ "id": "glm-4.5" }] }),
        ));

        let models = ZaiAdapter
            .fetch_models(&context("sk-zai"), &call(&transport, &EnvOverrides::new()))
            .await
            .expect("fetch");

        assert_eq!(models.len(), 1);
        assert_eq!(models[0].provider, "zai");
        let seen = transport.seen();
        assert_eq!(seen[0].method, http::Method::GET);
        assert_eq!(seen[0].url, "https://api.z.ai/api/paas/v4/models");
    }

    /// `zai/index.ts:19-30`: connectivity is a real `chat/completions` ping, not a
    /// models-list probe. The body is the literal from `:25-29` — `ping` content
    /// and `max_tokens: 4`, which is *not* the shared dispatch default.
    #[tokio::test]
    async fn connectivity_posts_a_minimal_ping_with_the_explicit_model() {
        let transport = StubTransport::new(HttpResponse::json(
            StatusCode::OK,
            &json!({ "choices": [{ "message": { "content": "pong" } }] }),
        ));

        let result = ZaiAdapter
            .test_connectivity(
                &context("sk-zai"),
                &call(&transport, &EnvOverrides::new()),
                Some("glm-4.6"),
            )
            .await;

        assert!(result.ok);
        assert_eq!(result.message, CONNECTIVITY_OK);
        let seen = transport.seen();
        assert_eq!(seen[0].method, http::Method::POST);
        assert_eq!(seen[0].url, "https://api.z.ai/api/paas/v4/chat/completions");
        assert_eq!(
            seen[0].headers.get("content-type").expect("content type"),
            "application/json"
        );
        assert_eq!(
            seen[0].body.as_deref().expect("body"),
            r#"{"model":"glm-4.6","messages":[{"role":"user","content":"ping"}],"max_tokens":4}"#
        );
    }

    /// The first half of `options.model || provider.defaultModels[0]`
    /// (`zai/index.ts:14`): with no model requested the ping uses the catalog's
    /// first Z.AI default (`glm-4.5`, `provider_catalog.rs:230` / `providerCatalog.ts`).
    #[tokio::test]
    async fn connectivity_falls_back_to_the_first_catalog_default_model() {
        let context = context("sk-zai");
        assert_eq!(context.provider.default_models[0], "glm-4.5");

        let transport = StubTransport::new(HttpResponse::json(
            StatusCode::OK,
            &json!({ "choices": [{ "message": { "content": "pong" } }] }),
        ));

        let result = ZaiAdapter
            .test_connectivity(&context, &call(&transport, &EnvOverrides::new()), None)
            .await;

        assert!(result.ok);
        assert_eq!(
            transport.seen()[0].body.as_deref().expect("body"),
            r#"{"model":"glm-4.5","messages":[{"role":"user","content":"ping"}],"max_tokens":4}"#,
            "provider.defaultModels[0], not defaultModels[1] (glm-4.5-air)"
        );
    }

    /// `zai/index.ts:15-17`: with neither an explicit model nor a catalog default
    /// the adapter returns the literal message and issues no request at all —
    /// `UnreachableTransport` would surface a transport error if it did.
    #[tokio::test]
    async fn connectivity_without_any_model_reports_the_missing_model_message() {
        let mut context = context("sk-zai");
        context.provider.default_models.clear();

        let result = ZaiAdapter
            .test_connectivity(
                &context,
                &call(&UnreachableTransport, &EnvOverrides::new()),
                None,
            )
            .await;

        assert!(!result.ok);
        assert_eq!(result.message, MISSING_MODEL);
    }

    /// `zai/index.ts:34`: `Z.AI connectivity failed: ` plus the `fetchJsonOk`
    /// reason — here the `error.message` branch of a JSON body
    /// (`shared/http.ts:56-59`).
    #[tokio::test]
    async fn connectivity_failure_uses_the_zai_prefix() {
        let transport = StubTransport::new(HttpResponse::json(
            StatusCode::UNAUTHORIZED,
            &json!({ "error": { "message": "invalid api key" } }),
        ));

        let result = ZaiAdapter
            .test_connectivity(
                &context("sk-bad"),
                &call(&transport, &EnvOverrides::new()),
                None,
            )
            .await;

        assert!(!result.ok);
        assert_eq!(result.message, "Z.AI connectivity failed: invalid api key");
    }

    /// The documented asymmetry of `zai/index.ts:22` versus the shared header
    /// builder: the ping interpolates `secret` verbatim, while `dispatchGateway`
    /// runs `normalizeBearerSecret` (`utils.ts:5-19`). A stored secret that still
    /// carries its quotes reaches Z.AI unchanged on the probe.
    #[tokio::test]
    async fn the_ping_sends_the_raw_secret_while_dispatch_normalises_it() {
        let transport = StubTransport::new(HttpResponse::json(
            StatusCode::OK,
            &json!({ "choices": [{ "message": { "content": "ok" } }], "model": "glm-4.5" }),
        ));
        let env = EnvOverrides::new();
        let context = context("\"sk-quoted\"");

        let ping = ZaiAdapter
            .test_connectivity(&context, &call(&transport, &env), None)
            .await;
        assert!(ping.ok);

        let response = ZaiAdapter
            .dispatch_gateway(
                &context,
                &call(&transport, &env),
                &GatewayRequest::new("glm-4.5", vec![GatewayMessage::user("hi")]),
                &DispatchOptions::default(),
            )
            .await
            .expect("dispatch");
        assert!(response.ok);
        assert_eq!(response.provider, "zai");

        let seen = transport.seen();
        assert_eq!(seen.len(), 2);
        assert_eq!(
            seen[0].headers.get("authorization").expect("ping auth"),
            "Bearer \"sk-quoted\"",
            "zai/index.ts:22 interpolates the secret verbatim"
        );
        assert_eq!(
            seen[1].headers.get("authorization").expect("chat auth"),
            "Bearer sk-quoted",
            "buildOptionalAuthHeaders normalises"
        );
        assert_eq!(seen[1].method, http::Method::POST);
        assert_eq!(seen[1].url, "https://api.z.ai/api/paas/v4/chat/completions");
    }
}
