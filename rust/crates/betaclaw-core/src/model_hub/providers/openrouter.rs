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
