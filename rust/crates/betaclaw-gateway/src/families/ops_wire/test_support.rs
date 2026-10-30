//! Harness of the ops family's route tests. Compiled for `cargo test` only.
//!
//! The stores live in a scratch directory under the system temp dir. The
//! diagnostics and BetaClaw ports are replaced by fakes where a test needs a
//! successful collaborator; every other port stays [`Unwired`].

use std::path::PathBuf;
use std::sync::Arc;

use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use axum::Extension;
use betaclaw_core::config::GatewayConfig;
use betaclaw_core::gateway_config::ConfigBackend;
use betaclaw_core::model_hub::env::EnvOverrides;
use betaclaw_core::skills::exec_approval::ExecApprovalStore;
use betaclaw_core::stats::engineering_migrations::run_engineering_migrations;
use serde_json::{json, Value};
use tower::ServiceExt;

use super::ports::{BetaClawPort, DiagnosticsPort, PortError, PortFuture, Unwired};
use super::{assemble, Services};
use crate::state::{AppState, SharedState};

/// A scratch directory under the system temp dir, removed when dropped.
pub struct ScratchDir(PathBuf);

impl ScratchDir {
    fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("betaclaw-ops-wire-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).expect("create scratch dir");
        Self(path)
    }

    pub fn path(&self, name: &str) -> String {
        self.0.join(name).to_string_lossy().into_owned()
    }
}

impl Drop for ScratchDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

pub fn scratch() -> ScratchDir {
    ScratchDir::new()
}

/// Gateway state whose stores all live inside `scratch`.
pub fn state_in(scratch: &ScratchDir) -> SharedState {
    state_with_config(scratch, |_| {})
}

/// Gateway state whose `MC_API_TOKEN` is `token`: a bearer request with that token is
/// the operator.
pub fn state_with_mc_token(scratch: &ScratchDir, token: &str) -> SharedState {
    state_with_config(scratch, |config| {
        config.mc_api_token = Some(token.to_string())
    })
}

fn state_with_config(scratch: &ScratchDir, edit: impl FnOnce(&mut GatewayConfig)) -> SharedState {
    let mut config = GatewayConfig::from_env().expect("test configuration resolves");
    config.logs_db_path = ":memory:".to_string();
    config.gateway_config_db_path = scratch.path("gateway-config.db");
    config.gateway_config_backend = ConfigBackend::Db;
    config.gateway_config_path = scratch.path("betaclaw.json");
    config.personas_db_path = scratch.path("personas.db");
    config.personas_root_path = scratch.path("personas");
    config.messages_db_path = scratch.path("messages.db");
    config.upstream_origin = upstream_stub();
    edit(&mut config);
    Arc::new(AppState::new(config).expect("state initialises"))
}

/// A local upstream that drops every connection, so a proxied request fails at once.
fn upstream_stub() -> String {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind upstream stub");
    listener
        .set_nonblocking(true)
        .expect("non-blocking upstream stub");
    let address = listener.local_addr().expect("upstream stub address");
    tokio::spawn(async move {
        let listener = tokio::net::TcpListener::from_std(listener).expect("adopt upstream stub");
        while let Ok((stream, _)) = listener.accept().await {
            drop(stream);
        }
    });
    format!("http://{address}")
}

/// [`assemble`] with the stores inside `scratch` and the given environment pins.
pub fn services_with_env(scratch: &ScratchDir, pins: &[(&str, &str)]) -> Services {
    // The migration runner creates the engineering tables before the gateway starts.
    let main_db = scratch.path("mission-control.db");
    let mut connection = rusqlite::Connection::open(&main_db).expect("open main db");
    run_engineering_migrations(&mut connection).expect("engineering migrations");
    drop(connection);
    let mut env = EnvOverrides::new()
        .with("AUTOMATION_DB_PATH", scratch.path("automation.db"))
        .with("STATS_DB_PATH", scratch.path("stats.db"))
        .with("DATABASE_PATH", main_db)
        .with("MODEL_HUB_DB_PATH", scratch.path("model-hub.db"));
    for (key, value) in pins {
        env = env.with(*key, *value);
    }
    let approvals = ExecApprovalStore::new(scratch.path("exec-approvals.json"));
    let messages_db = scratch.path("messages.db");
    let links = super::GatewayLinks {
        logs_db_path: ":memory:",
        messages_db_path: &messages_db,
        registry: Arc::new(betaclaw_core::gateway::registry::ClientRegistry::new()),
        http: reqwest::Client::new(),
    };
    assemble(&env, approvals, links).expect("services build")
}

pub fn fake_services(scratch: &ScratchDir) -> Arc<Services> {
    Arc::new(services_with_env(scratch, &[]))
}

/// Services whose diagnostics port is [`Unwired`]: its routes answer 500 `not wired`.
pub fn services_unwired_diagnostics(scratch: &ScratchDir) -> Arc<Services> {
    let mut services = services_with_env(scratch, &[]);
    services.diagnostics = Arc::new(Unwired);
    Arc::new(services)
}

/// Services whose World Model port is [`Unwired`], so the metrics fall back to null.
pub fn services_unwired_world_model(scratch: &ScratchDir) -> Arc<Services> {
    let mut services = services_with_env(scratch, &[]);
    services.world_model = Arc::new(Unwired);
    Arc::new(services)
}

/// Services whose diagnostics port answers with a healthy report.
pub fn with_fake_diagnostics(scratch: &ScratchDir) -> Arc<Services> {
    let mut services = services_with_env(scratch, &[]);
    services.diagnostics = Arc::new(FakeDiagnostics);
    Arc::new(services)
}

/// Services whose BetaClaw port reports `can_access` for every session, no
/// database row, and a runtime that cannot be reached.
pub fn fake_betaclaw_services(scratch: &ScratchDir, can_access: bool) -> Arc<Services> {
    let mut services = services_with_env(scratch, &[]);
    services.betaclaw = Arc::new(FakeBetaClaw { can_access });
    Arc::new(services)
}

/// Sends one request through the family's router and returns status and JSON body.
pub async fn send(
    state: &SharedState,
    services: &Arc<Services>,
    method: Method,
    uri: &str,
    headers: &[(&str, &str)],
    body: Option<&str>,
) -> (StatusCode, Value) {
    let mut builder = Request::builder().method(method).uri(uri);
    for (name, value) in headers {
        builder = builder.header(*name, *value);
    }
    let request_body = match body {
        Some(text) => {
            builder = builder.header("content-type", "application/json");
            Body::from(text.to_string())
        }
        None => Body::empty(),
    };
    let request = builder.body(request_body).expect("valid request");
    let response = super::router()
        .layer(Extension(services.clone()))
        .with_state(state.clone())
        .oneshot(request)
        .await
        .expect("infallible service");
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
        .await
        .expect("read body");
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

struct FakeDiagnostics;

impl DiagnosticsPort for FakeDiagnostics {
    fn health(&self, _memory_diagnostics: bool) -> PortFuture<'_, Value> {
        Box::pin(async {
            Ok(json!({
                "status": "ok",
                "checks": [],
                "summary": { "ok": 1, "warning": 0, "critical": 0, "skipped": 0 },
                "generatedAt": "2026-01-01T00:00:00.000Z",
            }))
        })
    }

    fn doctor(&self, _memory_diagnostics: bool) -> PortFuture<'_, Value> {
        Box::pin(async {
            Ok(json!({
                "status": "ok",
                "findings": [],
                "recommendations": [],
                "generatedAt": "2026-01-01T00:00:00.000Z",
            }))
        })
    }
}

struct FakeBetaClaw {
    can_access: bool,
}

impl BetaClawPort for FakeBetaClaw {
    fn runtime_connect(&self) -> PortFuture<'_, ()> {
        Box::pin(async { Err(PortError::Failed("runtime unreachable".to_string())) })
    }

    fn accessible_workspace_ids(&self, _user_id: String) -> PortFuture<'_, Vec<String>> {
        Box::pin(async { Ok(vec!["ws-1".to_string()]) })
    }

    fn has_workspace_access(
        &self,
        _user_id: String,
        _workspace_id: String,
    ) -> PortFuture<'_, bool> {
        Box::pin(async { Ok(true) })
    }

    fn can_access_session(&self, _user_id: String, _session_id: String) -> PortFuture<'_, bool> {
        let allowed = self.can_access;
        Box::pin(async move { Ok(allowed) })
    }

    fn db_find_runtime_session(&self, _session_id: String) -> PortFuture<'_, Option<Value>> {
        Box::pin(async { Ok(None) })
    }

    fn db_find_session(&self, _session_id: String) -> PortFuture<'_, Option<Value>> {
        Box::pin(async { Ok(None) })
    }
}
