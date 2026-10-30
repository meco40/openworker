//! Harness for the master route tests. Compiled for `cargo test` only.
//!
//! The harness attaches [`Services`] as the integrator does, and gives the proxy
//! fallback a refused upstream so a proxied call answers `502` at once.

use std::path::PathBuf;
use std::sync::Arc;

use axum::body::Body;
use axum::extract::Extension;
use axum::http::{Method, Request, Response, StatusCode};
use betaclaw_core::automation::service::AutomationService;
use betaclaw_core::automation::sqlite_repository::SqliteAutomationRepository;
use betaclaw_core::config::GatewayConfig;
use betaclaw_core::gateway_config::ConfigBackend;
use betaclaw_core::master::feature_flags::MasterEnv;
use betaclaw_core::personas::PersonaWorkspace;
use betaclaw_core::skills::exec_approval::ExecApprovalStore;
use betaclaw_core::skills::types::{SkillEnv, SkillExecConfig};
use serde_json::Value;
use tower::ServiceExt;

use super::action_bridge::ActionBridge;
use super::automation::{AutomationRuntimePort, UnwiredPromptRunner};
use super::skills::{CoreSkillDispatcher, SkillDispatcher};
use super::{build, router, RuntimeSeams, Services};
use crate::model_hub_transport::ReqwestTransport;
use crate::state::{AppState, SharedState};

/// The identity every test acts as.
pub const OWNER: &str = "user-1";
/// The query a scoped GET carries. The workspace is required, as in the source.
pub const SCOPE: &str = "?workspaceId=main";

/// A scratch directory under the system temp dir, removed when dropped.
struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("betaclaw-master-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).expect("create scratch dir");
        Self(path)
    }

    fn path(&self, name: &str) -> String {
        self.0.join(name).to_string_lossy().into_owned()
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Services and gateway state over fresh stores, with one router per request.
pub struct Harness {
    pub services: Arc<Services>,
    state: SharedState,
    _scratch: Scratch,
}

impl Harness {
    pub fn new() -> Self {
        Self::assemble(MasterEnv::new(), None)
    }

    pub fn with_env(env: MasterEnv) -> Self {
        Self::assemble(env, None)
    }

    /// A harness whose cron bridge writes through `automation` instead of a fresh store.
    pub fn with_automation(automation: Arc<dyn AutomationRuntimePort>) -> Self {
        Self::assemble(MasterEnv::new(), Some(automation))
    }

    fn assemble(env: MasterEnv, automation: Option<Arc<dyn AutomationRuntimePort>>) -> Self {
        let scratch = Scratch::new();
        let automation: Arc<dyn AutomationRuntimePort> = match automation {
            Some(automation) => automation,
            None => Arc::new(AutomationService::new(
                SqliteAutomationRepository::open(&scratch.path("automation.db"))
                    .expect("automation store"),
                UnwiredPromptRunner,
            )),
        };
        let skills: Arc<dyn SkillDispatcher> = Arc::new(CoreSkillDispatcher::new(
            Arc::new(ReqwestTransport::new()),
            None,
            SkillEnv {
                personas: PersonaWorkspace::new(scratch.path("skill-personas")),
                approvals: ExecApprovalStore::new(scratch.path("approvals.json")),
                exec: SkillExecConfig::from_env(),
            },
        ));
        let services = Arc::new(
            build(
                &scratch.path("master.db"),
                &scratch.path("personas.db"),
                &scratch.path("personas"),
                &scratch.path("model-hub.db"),
                env,
                RuntimeSeams {
                    automation,
                    skills,
                    action_bridge: Arc::new(ActionBridge::direct()),
                    process_bus: None,
                },
            )
            .expect("services build"),
        );
        let state = state_in(&scratch);
        Self {
            services,
            state,
            _scratch: scratch,
        }
    }

    /// Sends one request and returns the raw response, body unread.
    pub async fn raw(
        &self,
        method: Method,
        uri: &str,
        user: Option<&str>,
        body: Option<&str>,
    ) -> Response<Body> {
        let mut builder = Request::builder().method(method).uri(uri);
        if let Some(user) = user {
            builder = builder.header("x-betaclaw-user-id", user);
        }
        let body = match body {
            Some(text) => {
                builder = builder.header("content-type", "application/json");
                Body::from(text.to_string())
            }
            None => Body::empty(),
        };
        let request = builder.body(body).expect("valid request");
        router()
            .layer(Extension(self.services.clone()))
            .with_state(self.state.clone())
            .oneshot(request)
            .await
            .expect("infallible service")
    }

    /// Sends one request and returns the status and the JSON body.
    pub async fn send(
        &self,
        method: Method,
        uri: &str,
        user: Option<&str>,
        body: Option<&str>,
    ) -> (StatusCode, Value) {
        let response = self.raw(method, uri, user, body).await;
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
            .await
            .expect("read body");
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }
}

fn state_in(scratch: &Scratch) -> SharedState {
    let mut config = GatewayConfig::from_env().expect("test configuration resolves");
    config.logs_db_path = ":memory:".to_string();
    config.gateway_config_db_path = scratch.path("gateway-config.db");
    config.gateway_config_backend = ConfigBackend::Db;
    config.gateway_config_path = scratch.path("betaclaw.json");
    config.personas_db_path = scratch.path("state-personas.db");
    config.personas_root_path = scratch.path("state-personas");
    config.messages_db_path = scratch.path("messages.db");
    // Nothing listens on port 9, so a proxied request fails at once with 502.
    config.upstream_origin = "http://127.0.0.1:9".to_string();
    Arc::new(AppState::new(config).expect("state initialises"))
}
