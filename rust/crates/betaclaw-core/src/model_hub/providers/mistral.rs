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
