//! Harness for the unit tests of this family. Compiled for `cargo test` only.
//!
//! Every store lives in a scratch directory, the router is the family's own, and
//! the upstream of the reverse proxy is a stub that drops each connection, so a
//! proxied request answers 502 at once.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use axum::response::Response;
use axum::{Extension, Router};
use betaclaw_core::config::GatewayConfig;
use betaclaw_core::gateway_config::ConfigBackend;
use serde_json::Value;
use tower::ServiceExt;

use super::{build, Services, StatsWireConfig};
use crate::state::{AppState, SharedState};

/// A scratch directory under the system temp dir, removed when dropped.
pub struct Scratch(PathBuf);

impl Scratch {
    pub fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("betaclaw-stats-wire-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).expect("create scratch dir");
        Self(path)
    }

    pub fn path(&self, name: &str) -> String {
        self.0.join(name).to_string_lossy().into_owned()
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Two domains, enough for the engineering snapshot's coverage.
const REGISTRY: &str = r#"{
  "version": 1,
  "generatedAt": "2026-10-11T00:00:00.000Z",
  "domains": [
    {"id": "alpha", "display": "Alpha", "systemDoc": "docs/a.md", "contract": "docs/contracts/a.md",
     "owner": "team", "risk": "low", "paths": ["src/a/**"], "scenarios": ["s1"], "tests": ["t1"]},
    {"id": "beta", "display": "Beta", "systemDoc": "docs/b.md", "contract": "docs/contracts/b.md",
     "owner": "team", "risk": "high", "paths": ["src/b/**"], "scenarios": ["s2"], "tests": ["t2"]}
  ]
}"#;

/// Store paths under `scratch`, a 20 ms keep-alive and the registry above.
pub fn config_in(scratch: &Scratch) -> StatsWireConfig {
    let registry = scratch.path("DOMAIN_REGISTRY.json");
    std::fs::write(&registry, REGISTRY).expect("write registry");
    StatsWireConfig {
        stats_db_path: scratch.path("stats.db"),
        knowledge_db_path: scratch.path("knowledge.db"),
        main_db_path: scratch.path("main.db"),
        master_db_path: scratch.path("master.db"),
        rollout_config_path: PathBuf::from(scratch.path("missing-rollout.json")),
        domain_registry_path: PathBuf::from(registry),
        sse_max_clients: 20,
        sse_keepalive: Duration::from_millis(20),
    }
}

/// Builds the services over the scratch stores.
pub fn services_in(scratch: &Scratch) -> Arc<Services> {
    Arc::new(build(&config_in(scratch)).expect("services build"))
}

/// Gateway state whose stores all live inside `scratch`. `require_auth` decides
/// whether a caller without a session sees every workspace.
pub fn state_in(scratch: &Scratch, require_auth: bool) -> SharedState {
    let mut config = GatewayConfig::from_env().expect("test configuration resolves");
    config.logs_db_path = ":memory:".to_string();
    config.gateway_config_db_path = scratch.path("gateway-config.db");
    // Pinned so a developer's BETACLAW_CONFIG_BACKEND cannot leak into the tests.
    config.gateway_config_backend = ConfigBackend::Db;
    config.gateway_config_path = scratch.path("betaclaw.json");
    config.personas_db_path = scratch.path("personas.db");
    config.personas_root_path = scratch.path("personas");
    config.messages_db_path = scratch.path("messages.db");
    config.upstream_origin = upstream_stub();
    config.require_auth = require_auth;
    Arc::new(AppState::new(config).expect("state initialises"))
}

/// The family's router with the state and the services attached, as the integrator
/// wires it.
pub fn app(state: &SharedState, services: &Arc<Services>) -> Router {
    super::router()
        .layer(Extension(Arc::clone(services)))
        .with_state(state.clone())
}

/// Binds a local upstream that accepts each connection and drops it at once. The
/// accept task lives on the calling test's runtime, so every caller is a
/// `#[tokio::test]`.
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

/// Sends one request and returns the raw response, for streaming bodies.
pub async fn send_raw(
    router: &Router,
    method: Method,
    uri: &str,
    user: Option<&str>,
    body: Option<&str>,
) -> Response {
    let mut builder = Request::builder().method(method).uri(uri);
    if let Some(user) = user {
        builder = builder.header("x-betaclaw-user-id", user);
    }
    let request_body = match body {
        Some(text) => {
            builder = builder.header("content-type", "application/json");
            Body::from(text.to_string())
        }
        None => Body::empty(),
    };
    let request = builder.body(request_body).expect("valid request");
    router
        .clone()
        .oneshot(request)
        .await
        .expect("infallible service")
}

/// Sends one request and returns the status and the JSON body.
pub async fn send(
    router: &Router,
    method: Method,
    uri: &str,
    user: Option<&str>,
    body: Option<&str>,
) -> (StatusCode, Value) {
    let response = send_raw(router, method, uri, user, body).await;
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
        .await
        .expect("read body");
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

/// Asserts that a JSON object has exactly these keys, in any order.
pub fn assert_keys(value: &Value, expected: &[&str]) {
    let mut actual: Vec<&str> = value
        .as_object()
        .expect("JSON object")
        .keys()
        .map(String::as_str)
        .collect();
    let mut wanted = expected.to_vec();
    actual.sort_unstable();
    wanted.sort_unstable();
    assert_eq!(actual, wanted);
}
