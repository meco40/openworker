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
