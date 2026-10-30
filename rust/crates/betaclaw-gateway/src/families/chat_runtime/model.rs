//! The model hub: the `ModelGateway` port.
//!
//! Port of `src/server/model-hub/runtime.ts` as composed by `routes::model_hub`: the
//! SQLite repository, the shared HTTP transport and the no-op observer, attachment reader
//! and Codex refresher that the route also uses.

use std::sync::Arc;

use betaclaw_core::channels::messages::service::execution::ports::PortResult;
use betaclaw_core::channels::messages::service::ports::{BoxFuture, ModelGateway};
use betaclaw_core::knowledge::extractor::{ExtractionModel, ExtractionModelError};
use betaclaw_core::model_hub::env::EnvOverrides;
use betaclaw_core::model_hub::http::HttpTransport;
use betaclaw_core::model_hub::openai_compatible::NOOP_ATTACHMENT_STORE;
use betaclaw_core::model_hub::repository::RepositoryError;
use betaclaw_core::model_hub::runtime::{
    get_model_hub_encryption_key, get_model_hub_service, RuntimeError,
};
use betaclaw_core::model_hub::service::gateway::NoopObserver;
use betaclaw_core::model_hub::service::refresh::NoCodexRefresh;
use betaclaw_core::model_hub::service::types::DispatchWithFallbackOptions;
use betaclaw_core::model_hub::service::ServiceDependencies;
use betaclaw_core::model_hub::sqlite::SqliteModelHubRepository;
use betaclaw_core::model_hub::types::{
    GatewayAuditContext, GatewayAuditKind, GatewayMessage, GatewayRequest, GatewayResponse,
};

use super::failed;

pub struct ModelHubGateway {
    repository: SqliteModelHubRepository,
    transport: Arc<dyn HttpTransport>,
    env: EnvOverrides,
    /// Resolved once at start-up. A missing key is reported per call, not at start-up,
    /// as `routes::model_hub` reports it per request.
    encryption_key: Result<String, RuntimeError>,
}

impl ModelHubGateway {
    pub fn open(
        db_path: &str,
        transport: Arc<dyn HttpTransport>,
        env: EnvOverrides,
    ) -> Result<Self, RepositoryError> {
        let repository = SqliteModelHubRepository::open(db_path)?;
        let encryption_key = get_model_hub_encryption_key(&env);
        Ok(Self {
            repository,
            transport,
            env,
            encryption_key,
        })
    }
}

impl ModelGateway for ModelHubGateway {
    fn encryption_key(&self) -> PortResult<String> {
        self.encryption_key.clone().map_err(failed)
    }

    fn dispatch_with_fallback(
        &self,
        profile_id: String,
        encryption_key: String,
        request: GatewayRequest,
        options: DispatchWithFallbackOptions,
    ) -> BoxFuture<'_, PortResult<GatewayResponse>> {
        Box::pin(async move {
            let dependencies = ServiceDependencies {
                transport: self.transport.as_ref(),
                attachments: &NOOP_ATTACHMENT_STORE,
                observer: &NoopObserver,
                env: &self.env,
                codex: &NoCodexRefresh,
            };
            let service = get_model_hub_service(&self.repository, dependencies);
            service
                .dispatch_with_fallback(&profile_id, &encryption_key, &request, Some(&options))
                .await
                .map_err(failed)
        })
    }
}

/// Shared handle to [`ModelHubGateway`] that implements [`ExtractionModel`].
#[derive(Clone)]
pub struct SharedModelHub(pub Arc<ModelHubGateway>);

impl ExtractionModel for SharedModelHub {
    async fn run_extraction_model(&self, prompt: &str) -> Result<String, ExtractionModelError> {
        let encryption_key = self
            .0
            .encryption_key
            .clone()
            .map_err(|error| ExtractionModelError(error.to_string()))?;
        let mut request = GatewayRequest::new("", vec![GatewayMessage::user(prompt)]);
        request.audit_context = Some(GatewayAuditContext {
            kind: GatewayAuditKind::KnowledgeExtraction,
            conversation_id: None,
            turn_seq: None,
            memory_context: None,
            task_id: None,
            step_id: None,
            node_id: None,
        });
        let dependencies = ServiceDependencies {
            transport: self.0.transport.as_ref(),
            attachments: &NOOP_ATTACHMENT_STORE,
            observer: &NoopObserver,
            env: &self.0.env,
            codex: &NoCodexRefresh,
        };
        let service = get_model_hub_service(&self.0.repository, dependencies);
        let response = service
            .dispatch_with_fallback("p1", &encryption_key, &request, None)
            .await
            .map_err(|error| ExtractionModelError(error.to_string()))?;
        if !response.ok {
            return Err(ExtractionModelError(format!(
                "Knowledge extraction model call failed: {}",
                response.error.as_deref().unwrap_or("unknown")
            )));
        }
        Ok(response.text)
    }
}

#[cfg(test)]
mod tests {
    use super::super::test_support::Scratch;
    use super::*;
    use betaclaw_core::model_hub::http::UnreachableTransport;
    use betaclaw_core::model_hub::runtime::TEST_MODE_ENCRYPTION_KEY;

    #[test]
    fn the_configured_key_is_returned_and_a_missing_key_is_reported_per_call() {
        let scratch = Scratch::new();
        let db = scratch.path("model-hub.db");

        let keyed = ModelHubGateway::open(
            &db,
            Arc::new(UnreachableTransport),
            EnvOverrides::new().with("MODEL_HUB_ENCRYPTION_KEY", TEST_MODE_ENCRYPTION_KEY),
        )
        .expect("open");
        assert_eq!(
            keyed.encryption_key().expect("key"),
            TEST_MODE_ENCRYPTION_KEY
        );

        // A malformed key fails the call, not the start-up.
        let unkeyed = ModelHubGateway::open(
            &db,
            Arc::new(UnreachableTransport),
            EnvOverrides::new().with("MODEL_HUB_ENCRYPTION_KEY", "short"),
        )
        .expect("open");
        assert!(unkeyed.encryption_key().is_err());
    }
}
