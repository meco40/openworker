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
