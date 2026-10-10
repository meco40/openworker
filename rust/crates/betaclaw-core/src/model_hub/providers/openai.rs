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
