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
