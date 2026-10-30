//! Port of `src/server/model-hub/Models/openrouter/index.ts`.
//!
//! OpenRouter is the only ported provider that does **not** use the shared
//! models/connectivity helpers. It has its own `/models` mapping that keeps the
//! display `name` and `context_length`, a dedicated `/key` connectivity endpoint,
//! and two attribution headers on every chat request.
//!
//! As with Z.AI and ByteDance, both raw calls send `Bearer ${secret}` without
//! `normalizeBearerSecret`, while `dispatchGateway` goes through the shared header
//! builder and therefore *does* normalise. Ported verbatim.

use crate::model_hub::http::{
    fetch_json_ok, fetch_with_timeout, BoxFuture, HttpError, HttpRequest,
    DEFAULT_REQUEST_TIMEOUT_MS,
};
use crate::model_hub::openai_compatible::{dispatch_openai_compatible_chat, DispatchOptions};
use crate::model_hub::types::{
    ConnectivityResult, FetchedModel, GatewayRequest, GatewayResponse, ProviderExecutionContext,
};

use super::{ProviderAdapter, ProviderCall};

/// `https://openrouter.ai/api/v1` from `openrouter/index.ts:30`.
pub const BASE_URL: &str = "https://openrouter.ai/api/v1";
/// `https://openrouter.ai/api/v1/key` from `openrouter/index.ts:21`.
pub const KEY_URL: &str = "https://openrouter.ai/api/v1/key";
/// `OpenRouter connectivity verified (key endpoint reachable).` from `openrouter/index.ts:29`.
pub const CONNECTIVITY_OK: &str = "OpenRouter connectivity verified (key endpoint reachable).";
/// `OpenRouter connectivity failed: ` from `openrouter/index.ts:30`.
pub const CONNECTIVITY_FAILURE_PREFIX: &str = "OpenRouter connectivity failed: ";
/// `HTTP-Referer` from `openrouter/index.ts:31-34`.
pub const HTTP_REFERER: &str = "https://github.com/meco40/openworker";
/// `X-Title` from `openrouter/index.ts:33`.
pub const X_TITLE: &str = "BetaClaw";

/// `openRouterProviderAdapter` from `openrouter/index.ts:5-38`.
#[derive(Debug, Clone, Copy, Default)]
pub struct OpenRouterAdapter;

impl ProviderAdapter for OpenRouterAdapter {
    fn id(&self) -> &'static str {
        "openrouter"
    }

    /// `openrouter/index.ts:9-24`. A non-2xx status yields an empty list; a
    /// transport failure propagates — `fetchModelsForAccount` catches it and falls
    /// back to `defaultModels`.
    fn fetch_models<'a>(
        &'a self,
        context: &'a ProviderExecutionContext,
        call: &'a ProviderCall<'_>,
    ) -> BoxFuture<'a, Result<Vec<FetchedModel>, HttpError>> {
        Box::pin(async move {
            let request = HttpRequest::get(format!("{BASE_URL}/models"))
                .header("Authorization", &format!("Bearer {}", context.secret));
            let response = fetch_with_timeout(call.transport, request).await?;
            if !response.is_ok() {
                return Ok(Vec::new());
            }
            let json: serde_json::Value = serde_json::from_str(&response.body)
                .map_err(|error| HttpError::InvalidBody(error.to_string()))?;

            Ok(json
                .get("data")
                .and_then(serde_json::Value::as_array)
                .map(|entries| {
                    entries
                        .iter()
                        .map(|model| {
                            let id = model
                                .get("id")
                                .and_then(serde_json::Value::as_str)
                                .unwrap_or("");
                            FetchedModel {
                                id: id.to_string(),
                                // `name: model.name || model.id`.
                                name: model
                                    .get("name")
                                    .and_then(serde_json::Value::as_str)
                                    .filter(|name| !name.is_empty())
                                    .unwrap_or(id)
                                    .to_string(),
                                provider: "openrouter".to_string(),
                                owned_by: None,
                                context_window: model
                                    .get("context_length")
                                    .and_then(serde_json::Value::as_f64),
                                created: None,
                                billing: None,
                            }
                        })
                        .collect()
                })
                .unwrap_or_default())
        })
    }

    /// `openrouter/index.ts:26-31`. Probes `/key`, not `/models`.
    fn test_connectivity<'a>(
        &'a self,
        context: &'a ProviderExecutionContext,
        call: &'a ProviderCall<'_>,
        _model: Option<&'a str>,
    ) -> BoxFuture<'a, ConnectivityResult> {
        Box::pin(async move {
            let request = HttpRequest::get(KEY_URL)
                .header("Authorization", &format!("Bearer {}", context.secret));
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

    /// `openrouter/index.ts:32-37` — the only adapter that passes
    /// `extraHeaders`.
    fn dispatch_gateway<'a>(
        &'a self,
        context: &'a ProviderExecutionContext,
        call: &'a ProviderCall<'_>,
        request: &'a GatewayRequest,
        options: &'a DispatchOptions,
    ) -> BoxFuture<'a, Result<GatewayResponse, HttpError>> {
        let mut merged = options.clone();
        merged
            .extra_headers
            .push(("HTTP-Referer".to_string(), HTTP_REFERER.to_string()));
        merged
            .extra_headers
            .push(("X-Title".to_string(), X_TITLE.to_string()));

        Box::pin(async move {
            dispatch_openai_compatible_chat(
                call.transport,
                call.attachments,
                BASE_URL,
                &context.secret,
                self.id(),
                request,
                &merged,
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
            provider: find_provider("openrouter")
                .expect("openrouter is in the catalog")
                .clone(),
            account: ProviderAccountRecord {
                id: "openrouter".to_string(),
                provider_id: "openrouter".to_string(),
                label: "openrouter".to_string(),
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

    /// `openrouter/index.ts:9-24` is a bespoke mapping the shared models helper does
    /// not perform: it keeps the display `name` (falling back to `id`), carries
    /// `context_length` into `context_window`, and never sets `owned_by` or
    /// `created` — even though the shared path maps those two.
    #[tokio::test]
    async fn fetch_models_keeps_the_display_name_and_the_context_length() {
        let transport = StubTransport::new(HttpResponse::json(
            StatusCode::OK,
            &json!({
                "data": [
                    {
                        "id": "openai/gpt-4.1-mini",
                        "name": "GPT-4.1 Mini",
                        "context_length": 1047576
                    },
                    { "id": "anthropic/claude-3.7-sonnet" }
                ]
            }),
        ));

        let models = OpenRouterAdapter
            .fetch_models(&context("sk-or"), &call(&transport, &EnvOverrides::new()))
            .await
            .expect("fetch");

        assert_eq!(models[0].id, "openai/gpt-4.1-mini");
        assert_eq!(models[0].name, "GPT-4.1 Mini");
        assert_eq!(models[0].context_window, Some(1047576.0));
        assert_eq!(models[0].provider, "openrouter");
        assert!(models[0].owned_by.is_none());

        // `name: model.name || model.id` (`openrouter/index.ts:21`): a missing name
        // falls back to the id, unlike the shared helper which always uses the id.
        assert_eq!(models[1].id, "anthropic/claude-3.7-sonnet");
        assert_eq!(models[1].name, "anthropic/claude-3.7-sonnet");
        assert_eq!(models[1].context_window, None);
        assert!(models[1].created.is_none());

        let seen = transport.seen();
        assert_eq!(seen[0].method, http::Method::GET);
        assert_eq!(seen[0].url, "https://openrouter.ai/api/v1/models");
        assert_eq!(
            seen[0].headers.get("authorization").expect("auth header"),
            "Bearer sk-or",
            "openrouter/index.ts:11 builds the header itself"
        );
    }

    /// `openrouter/index.ts:13`: `if (!response.ok) return []` — a rejected key
    /// yields an empty list instead of an error, so `fetchModelsForAccount` keeps
    /// its `defaultModels` fallback.
    #[tokio::test]
    async fn fetch_models_returns_an_empty_list_for_a_non_ok_status() {
        let transport = StubTransport::new(HttpResponse::text(StatusCode::UNAUTHORIZED, "nope"));

        let models = OpenRouterAdapter
            .fetch_models(&context("sk-bad"), &call(&transport, &EnvOverrides::new()))
            .await
            .expect("fetch");

        assert!(models.is_empty());
    }

    /// `openrouter/index.ts:27-31`: the probe targets the dedicated `/key`
    /// endpoint, not `/models` and not `chat/completions`.
    #[tokio::test]
    async fn connectivity_probes_the_key_endpoint() {
        let transport = StubTransport::new(HttpResponse::json(
            StatusCode::OK,
            &json!({ "data": { "label": "sk-or", "usage": 0 } }),
        ));

        let result = OpenRouterAdapter
            .test_connectivity(
                &context("sk-or"),
                &call(&transport, &EnvOverrides::new()),
                Some("openai/gpt-4.1-mini"),
            )
            .await;

        assert!(result.ok);
        assert_eq!(result.message, CONNECTIVITY_OK);
        let seen = transport.seen();
        assert_eq!(seen[0].method, http::Method::GET);
        assert_eq!(seen[0].url, KEY_URL);
        assert_eq!(seen[0].url, "https://openrouter.ai/api/v1/key");
        assert_eq!(
            seen[0].headers.get("authorization").expect("auth header"),
            "Bearer sk-or"
        );
    }

    /// `openrouter/index.ts:35`: `OpenRouter connectivity failed: ` plus the
    /// `fetchJsonOk` reason.
    #[tokio::test]
    async fn connectivity_failure_uses_the_openrouter_prefix() {
        let transport = StubTransport::new(HttpResponse::text(
            StatusCode::UNAUTHORIZED,
            "No auth credentials found",
        ));

        let result = OpenRouterAdapter
            .test_connectivity(
                &context("sk-bad"),
                &call(&transport, &EnvOverrides::new()),
                None,
            )
            .await;

        assert!(!result.ok);
        assert_eq!(
            result.message,
            "OpenRouter connectivity failed: No auth credentials found"
        );
    }

    /// `openrouter/index.ts:40-43` is the only adapter that passes `extraHeaders`.
    /// `buildRequestHeaders` (`request/headers.ts:8-12`) spreads `extraHeaders`
    /// after `Content-Type` and `Authorization`, so both attribution headers reach
    /// the wire without displacing the shared ones.
    #[tokio::test]
    async fn dispatch_sends_the_two_attribution_headers() {
        let transport = StubTransport::new(HttpResponse::json(
            StatusCode::OK,
            &json!({ "choices": [{ "message": { "content": "ok" } }], "model": "openai/gpt-4.1-mini" }),
        ));

        let response = OpenRouterAdapter
            .dispatch_gateway(
                &context("sk-or"),
                &call(&transport, &EnvOverrides::new()),
                &GatewayRequest::new("openai/gpt-4.1-mini", vec![GatewayMessage::user("hi")]),
                &DispatchOptions::default(),
            )
            .await
            .expect("dispatch");

        assert!(response.ok);
        assert_eq!(response.provider, "openrouter");
        let seen = transport.seen();
        assert_eq!(seen[0].method, http::Method::POST);
        assert_eq!(seen[0].url, "https://openrouter.ai/api/v1/chat/completions");
        assert_eq!(
            seen[0].headers.get("http-referer").expect("referer header"),
            HTTP_REFERER
        );
        assert_eq!(
            seen[0].headers.get("x-title").expect("title header"),
            X_TITLE
        );
        assert_eq!(
            seen[0].headers.get("authorization").expect("auth header"),
            "Bearer sk-or"
        );
        assert_eq!(
            seen[0].headers.get("content-type").expect("content type"),
            "application/json"
        );
    }
}
