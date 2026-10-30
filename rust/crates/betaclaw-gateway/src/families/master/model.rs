//! The model seam of the Master runtime: [`MasterModelDispatch`] over the Model Hub
//! chat.
//!
//! Port of `getModelHubService().dispatchWithFallback(profileId,
//! getModelHubEncryptionKey(), request)`, which the planner (`executionPlan.ts:72-105`)
//! and the code generator call. The key is resolved inside [`ModelHubDispatch`], so a
//! missing key is an `Err`, and the callers already treat every `Err` as a fallback.
//!
//! The Model Hub database is opened per call, as the personas and voice routes do.
//! The chat runs through [`drive_sync`], because the seam is synchronous.

use std::sync::Arc;

use betaclaw_core::master::execution::runtime::execution_plan::{
    MasterModelDispatch, MasterModelRequest, MasterModelResponse,
};
use betaclaw_core::model_hub::env::EnvOverrides;
use betaclaw_core::model_hub::http::HttpTransport;
use betaclaw_core::model_hub::openai_compatible::NOOP_ATTACHMENT_STORE;
use betaclaw_core::model_hub::runtime::get_model_hub_encryption_key;
use betaclaw_core::model_hub::service::gateway::NoopObserver;
use betaclaw_core::model_hub::service::refresh::NoCodexRefresh;
use betaclaw_core::model_hub::service::{ModelHubService, ServiceDependencies};
use betaclaw_core::model_hub::sqlite::SqliteModelHubRepository;
use betaclaw_core::model_hub::types::{
    GatewayAuditContext, GatewayAuditKind, GatewayMessage, GatewayRequest, GatewayRole,
};
use betaclaw_core::world_model::db::drive_sync;
use serde_json::Value;

/// The Model Hub dispatch behind the planner and the code generator.
pub struct ModelHubDispatch {
    db_path: String,
    transport: Arc<dyn HttpTransport + Send + Sync>,
    env: EnvOverrides,
}

impl ModelHubDispatch {
    pub fn new(
        db_path: impl Into<String>,
        transport: Arc<dyn HttpTransport + Send + Sync>,
        env: EnvOverrides,
    ) -> Self {
        Self {
            db_path: db_path.into(),
            transport,
            env,
        }
    }
}

impl MasterModelDispatch for ModelHubDispatch {
    fn dispatch_with_fallback(
        &self,
        profile_id: &str,
        request: &MasterModelRequest,
    ) -> Result<MasterModelResponse, String> {
        let key = get_model_hub_encryption_key(&self.env).map_err(|error| error.to_string())?;
        let repository =
            SqliteModelHubRepository::open(&self.db_path).map_err(|error| error.to_string())?;
        let codex = NoCodexRefresh;
        let service = ModelHubService::new(
            &repository,
            ServiceDependencies {
                transport: &*self.transport,
                attachments: &NOOP_ATTACHMENT_STORE,
                observer: &NoopObserver,
                env: &self.env,
                codex: &codex,
            },
        );
        let gateway = gateway_request(request)?;
        let response =
            match drive_sync(service.dispatch_with_fallback(profile_id, &key, &gateway, None)) {
                Ok(outcome) => outcome.map_err(|error| error.to_string())?,
                Err(error) => return Err(error.into_message()),
            };
        Ok(MasterModelResponse {
            ok: response.ok,
            error: response.error,
            text: response.text,
        })
    }
}

/// The `dispatchWithFallback` request of `executionPlan.ts:75-104` as a gateway request.
/// The profile picks the model, so `model` stays empty, as the TypeScript leaves it out.
fn gateway_request(request: &MasterModelRequest) -> Result<GatewayRequest, String> {
    let messages = request
        .messages
        .iter()
        .map(|message| {
            let role = match message.role.as_str() {
                "system" => GatewayRole::System,
                "user" => GatewayRole::User,
                "assistant" => GatewayRole::Assistant,
                other => return Err(format!("Unsupported message role: {other}")),
            };
            Ok(GatewayMessage::new(role, message.content.clone()))
        })
        .collect::<Result<Vec<_>, String>>()?;
    let kind = serde_json::from_value::<GatewayAuditKind>(
        request
            .audit_context
            .get("kind")
            .cloned()
            .unwrap_or(Value::Null),
    )
    .map_err(|error| error.to_string())?;
    let text_of = |key: &str| {
        request
            .audit_context
            .get(key)
            .and_then(Value::as_str)
            .map(str::to_string)
    };
    Ok(GatewayRequest {
        model: String::new(),
        messages,
        max_tokens: Some(request.max_tokens),
        temperature: Some(request.temperature),
        reasoning_effort: None,
        stream: None,
        system_instruction: None,
        tools: None,
        response_mime_type: None,
        response_format: None,
        audit_context: Some(GatewayAuditContext {
            kind,
            conversation_id: None,
            turn_seq: None,
            memory_context: None,
            task_id: text_of("taskId"),
            step_id: text_of("stepId"),
            node_id: None,
        }),
    })
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use betaclaw_core::master::execution::runtime::execution_plan::{
        MasterModelDispatch, MasterModelMessage, MasterModelRequest,
    };
    use betaclaw_core::model_hub::env::EnvOverrides;
    use betaclaw_core::model_hub::http::HttpTransport;
    use betaclaw_core::model_hub::types::GatewayAuditKind;
    use serde_json::json;

    use super::{gateway_request, ModelHubDispatch};
    use crate::model_hub_transport::ReqwestTransport;

    fn request(role: &str) -> MasterModelRequest {
        MasterModelRequest {
            messages: vec![MasterModelMessage {
                role: role.to_string(),
                content: "Contract:\nwrite a note".to_string(),
            }],
            temperature: 0.2,
            max_tokens: 500,
            audit_context: json!({ "kind": "worker_executor", "taskId": "run-1", "stepId": "step-1" }),
        }
    }

    #[test]
    fn the_request_keeps_roles_and_the_audit_identity() {
        let gateway = gateway_request(&request("user")).expect("maps");
        assert_eq!(gateway.messages.len(), 1);
        assert_eq!(gateway.max_tokens, Some(500));
        let audit = gateway.audit_context.expect("audit context");
        assert!(matches!(audit.kind, GatewayAuditKind::WorkerExecutor));
        assert_eq!(audit.task_id.as_deref(), Some("run-1"));
        assert_eq!(audit.step_id.as_deref(), Some("step-1"));
    }

    #[test]
    fn an_unknown_role_is_rejected_before_any_dispatch() {
        let error = gateway_request(&request("tool")).expect_err("unknown role");
        assert_eq!(error, "Unsupported message role: tool");
    }

    #[test]
    fn a_missing_key_is_an_error_so_the_planner_falls_back() {
        let dir = std::env::temp_dir().join(format!("model-{}", uuid::Uuid::new_v4().simple()));
        let transport: Arc<dyn HttpTransport + Send + Sync> = Arc::new(ReqwestTransport::new());
        let dispatch = ModelHubDispatch::new(
            dir.join("model-hub.db").to_string_lossy().into_owned(),
            transport,
            EnvOverrides::new()
                .with("MODEL_HUB_ENCRYPTION_KEY", "")
                .with("NODE_ENV", "production"),
        );
        let error = dispatch
            .dispatch_with_fallback("profile-1", &request("user"))
            .expect_err("no key");
        assert!(error.contains("MODEL_HUB_ENCRYPTION_KEY"), "{error}");
    }

    #[test]
    fn an_empty_pipeline_answers_a_failed_response_without_error() {
        let dir = std::env::temp_dir().join(format!("model-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).expect("scratch dir");
        let transport: Arc<dyn HttpTransport + Send + Sync> = Arc::new(ReqwestTransport::new());
        let dispatch = ModelHubDispatch::new(
            dir.join("model-hub.db").to_string_lossy().into_owned(),
            transport,
            EnvOverrides::new().with("MODEL_HUB_ENCRYPTION_KEY", "a".repeat(32)),
        );
        let outcome = dispatch.dispatch_with_fallback("profile-1", &request("user"));
        let _ = std::fs::remove_dir_all(&dir);
        let response = outcome.expect("dispatch runs");
        assert!(!response.ok);
        assert_eq!(
            response.error.as_deref(),
            Some("No active models in pipeline.")
        );
    }
}
