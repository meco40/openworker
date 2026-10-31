//! Mirrors `src/server/model-hub/Models/refuseless/index.ts`.

use super::{ProviderAdapter, ProviderCall};
use crate::model_hub::http::{BoxFuture, HttpError};
use crate::model_hub::openai_compatible::{
    dispatch_openai_compatible_chat, fetch_openai_compatible_models,
    test_openai_compatible_models_endpoint, DispatchOptions,
};
use crate::model_hub::types::{
    ConnectivityResult, FetchedModel, GatewayReasoningEffort, GatewayRequest, GatewayResponse,
    ProviderExecutionContext,
};

const BASE_URL: &str = "https://api.refuseless.com/v1";
const MODEL_ID: &str = "deepseek-v4.1-flash-abliterated";
const MODEL_NAME: &str = "DeepSeek V4.1 Flash 1017 Abliterated";
const CONTEXT_LIMIT: f64 = 1_048_576.0;
const OUTPUT_LIMIT: i64 = 131_072;

fn prepare_request(request: &GatewayRequest) -> GatewayRequest {
    let mut request = request.clone();
    if request.model == MODEL_ID {
        request.max_tokens = request.max_tokens.map(|tokens| tokens.min(OUTPUT_LIMIT));
    }
    // Refuseless has no medium reasoning level.
    if request.reasoning_effort == Some(GatewayReasoningEffort::Medium) {
        request.reasoning_effort = Some(GatewayReasoningEffort::Low);
    }
    request
}

#[derive(Debug, Clone, Copy, Default)]
pub struct RefuselessAdapter;

impl ProviderAdapter for RefuselessAdapter {
    fn id(&self) -> &'static str {
        "refuseless"
    }

    fn fetch_models<'a>(
        &'a self,
        context: &'a ProviderExecutionContext,
        call: &'a ProviderCall<'_>,
    ) -> BoxFuture<'a, Result<Vec<FetchedModel>, HttpError>> {
        Box::pin(async move {
            let mut models = fetch_openai_compatible_models(
                call.transport,
                BASE_URL,
                &context.secret,
                self.id(),
            )
            .await
            .unwrap_or_default();
            if !models.iter().any(|model| model.id == MODEL_ID) {
                models.push(FetchedModel {
                    id: MODEL_ID.to_string(),
                    name: MODEL_NAME.to_string(),
                    provider: self.id().to_string(),
                    owned_by: None,
                    context_window: None,
                    created: None,
                    billing: None,
                });
            }
            for model in &mut models {
                if model.id == MODEL_ID {
                    model.name = MODEL_NAME.to_string();
                    model.context_window = Some(CONTEXT_LIMIT);
                }
            }
            Ok(models)
        })
    }

    fn test_connectivity<'a>(
        &'a self,
        context: &'a ProviderExecutionContext,
        call: &'a ProviderCall<'_>,
        _model: Option<&'a str>,
    ) -> BoxFuture<'a, ConnectivityResult> {
        Box::pin(test_openai_compatible_models_endpoint(
            call.transport,
            BASE_URL,
            &context.secret,
            "Refuseless connectivity verified.",
            "Refuseless connectivity failed: ",
        ))
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
                &prepare_request(request),
                options,
            )
            .await
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model_hub::openai_compatible::request::build_request_body;

    #[test]
    fn refuseless_preserves_tools_and_applies_model_limits_and_reasoning() {
        let mut request = GatewayRequest::new(MODEL_ID, vec![]);
        request.max_tokens = Some(200_000);
        request.reasoning_effort = Some(GatewayReasoningEffort::Medium);
        request.tools = Some(vec![
            serde_json::json!({"type": "function", "function": {"name": "probe"}}),
        ]);
        let prepared = prepare_request(&request);
        let body = build_request_body(&prepared, "refuseless");
        assert_eq!(body["max_tokens"], OUTPUT_LIMIT);
        assert_eq!(body["reasoning_effort"], "low");
        assert_eq!(body["tools"][0]["function"]["name"], "probe");
        request.max_tokens = Some(64);
        request.reasoning_effort = Some(GatewayReasoningEffort::None);
        let prepared = prepare_request(&request);
        assert_eq!(prepared.max_tokens, Some(64));
        assert_eq!(
            build_request_body(&prepared, "refuseless")["reasoning_effort"],
            "none"
        );
        request.model = "glm-5.3-abliterated".to_string();
        request.max_tokens = Some(200_000);
        assert_eq!(prepare_request(&request).max_tokens, Some(200_000));
    }
}
