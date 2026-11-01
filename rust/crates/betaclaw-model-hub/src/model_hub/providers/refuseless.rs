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
    use std::sync::Mutex;

    use http::{HeaderMap, StatusCode};

    use super::*;
    use crate::model_hub::env::EnvOverrides;
    use crate::model_hub::http::{HttpRequest, HttpResponse, HttpTransport};
    use crate::model_hub::openai_compatible::request::build_request_body;
    use crate::model_hub::openai_compatible::NOOP_ATTACHMENT_STORE;
    use crate::model_hub::provider_catalog::find_provider;
    use crate::model_hub::repository::encrypted_secret_input;
    use crate::model_hub::types::{GatewayMessage, ProviderAccountRecord, ProviderAuthMethod};

    /// One canned reply (or transport failure) plus every request the adapter issued.
    struct StubTransport {
        reply: Result<HttpResponse, HttpError>,
        seen: Mutex<Vec<HttpRequest>>,
    }

    impl StubTransport {
        fn replying(reply: Result<HttpResponse, HttpError>) -> Self {
            Self {
                reply,
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
            let reply = self.reply.clone();
            Box::pin(async move { reply })
        }
    }

    fn json_reply(status: StatusCode, body: &str) -> Result<HttpResponse, HttpError> {
        Ok(HttpResponse::new(status, HeaderMap::new(), body))
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
            provider: find_provider("refuseless")
                .expect("refuseless is in the catalog")
                .clone(),
            account: ProviderAccountRecord {
                id: "refuseless".to_string(),
                provider_id: "refuseless".to_string(),
                label: "refuseless".to_string(),
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

    fn model_ids(models: &[FetchedModel]) -> Vec<&str> {
        models.iter().map(|model| model.id.as_str()).collect()
    }

    /// The live list is fetched from `/models`, and the catalogued model appears
    /// once, enriched with its name and context window (`refuseless/index.ts`,
    /// `refuseless-adapter.test.ts:11-27`).
    #[tokio::test]
    async fn fetch_models_enriches_the_live_entry_without_a_duplicate() {
        let transport = StubTransport::replying(json_reply(
            StatusCode::OK,
            &format!(r#"{{"data":[{{"id":"{MODEL_ID}"}}]}}"#),
        ));
        let env = EnvOverrides::new();
        let models = RefuselessAdapter
            .fetch_models(&context("refuseless-test-key"), &call(&transport, &env))
            .await
            .expect("models");

        assert_eq!(model_ids(&models), vec![MODEL_ID]);
        assert_eq!(models[0].name, MODEL_NAME);
        assert_eq!(models[0].provider, "refuseless");
        assert_eq!(models[0].context_window, Some(CONTEXT_LIMIT));
        assert_eq!(
            transport.seen()[0].url,
            "https://api.refuseless.com/v1/models"
        );
    }

    /// An empty live list still offers the catalogued model
    /// (`refuseless-adapter.test.ts:29-34`).
    #[tokio::test]
    async fn fetch_models_keeps_the_supplied_model_when_the_live_list_is_empty() {
        let transport = StubTransport::replying(json_reply(StatusCode::OK, r#"{"data":[]}"#));
        let env = EnvOverrides::new();
        let models = RefuselessAdapter
            .fetch_models(&context("refuseless-test-key"), &call(&transport, &env))
            .await
            .expect("models");

        assert_eq!(model_ids(&models), vec![MODEL_ID]);
        assert_eq!(models[0].context_window, Some(CONTEXT_LIMIT));
    }

    /// A network failure keeps the catalogued model and its metadata
    /// (`refuseless-adapter.test.ts:71-79`).
    #[tokio::test]
    async fn fetch_models_retains_the_model_metadata_on_a_network_failure() {
        let transport =
            StubTransport::replying(Err(HttpError::Transport("Network unavailable".to_string())));
        let env = EnvOverrides::new();
        let models = RefuselessAdapter
            .fetch_models(&context("refuseless-test-key"), &call(&transport, &env))
            .await
            .expect("models");

        assert_eq!(model_ids(&models), vec![MODEL_ID]);
        assert_eq!(models[0].name, MODEL_NAME);
        assert_eq!(models[0].context_window, Some(CONTEXT_LIMIT));
    }

    /// Bearer auth on the chat endpoint, the output cap and the medium-to-low
    /// reasoning mapping reach the wire (`refuseless-adapter.test.ts:36-59`).
    #[tokio::test]
    async fn dispatch_sends_bearer_auth_with_the_output_cap_and_tools() {
        let transport = StubTransport::replying(json_reply(
            StatusCode::OK,
            r#"{"choices":[{"message":{"content":"OK"}}]}"#,
        ));
        let env = EnvOverrides::new();
        let mut request = GatewayRequest::new(MODEL_ID, vec![GatewayMessage::user("Say OK")]);
        request.max_tokens = Some(200_000);
        request.reasoning_effort = Some(GatewayReasoningEffort::Medium);
        request.tools = Some(vec![
            serde_json::json!({"type": "function", "function": {"name": "probe", "parameters": {"type": "object"}}}),
        ]);

        let response = RefuselessAdapter
            .dispatch_gateway(
                &context("refuseless-test-key"),
                &call(&transport, &env),
                &request,
                &DispatchOptions::default(),
            )
            .await
            .expect("dispatch");

        assert!(response.ok);
        assert_eq!(response.text, "OK");
        assert_eq!(response.provider, "refuseless");
        let sent = transport.seen();
        assert_eq!(
            sent[0].url,
            "https://api.refuseless.com/v1/chat/completions"
        );
        assert_eq!(
            sent[0].headers.get("authorization").expect("authorization"),
            "Bearer refuseless-test-key"
        );
        let body: serde_json::Value =
            serde_json::from_str(sent[0].body.as_deref().expect("body")).expect("json body");
        assert_eq!(body["max_tokens"], OUTPUT_LIMIT);
        assert_eq!(body["reasoning_effort"], "low");
        assert_eq!(body["tools"][0]["function"]["name"], "probe");
    }

    /// An invalid key is a failed probe that carries the server's text
    /// (`refuseless-adapter.test.ts:61-69`).
    #[tokio::test]
    async fn connectivity_does_not_report_an_invalid_key_as_success() {
        let transport = StubTransport::replying(Ok(HttpResponse::new(
            StatusCode::UNAUTHORIZED,
            HeaderMap::new(),
            "Invalid API key",
        )));
        let env = EnvOverrides::new();
        let result = RefuselessAdapter
            .test_connectivity(
                &context("refuseless-test-key"),
                &call(&transport, &env),
                None,
            )
            .await;

        assert!(!result.ok);
        assert!(
            result.message.contains("Invalid API key"),
            "{}",
            result.message
        );
    }

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
