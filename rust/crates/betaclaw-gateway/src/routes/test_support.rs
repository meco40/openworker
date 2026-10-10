//! Harness shared by the route unit tests. Compiled for `cargo test` only.

use std::path::PathBuf;

use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use betaclaw_core::config::GatewayConfig;
use betaclaw_core::gateway_config::ConfigBackend;
use serde_json::Value;
use tower::ServiceExt;

use crate::state::{AppState, SharedState};

/// A scratch directory under the system temp dir, removed when dropped.
pub struct ScratchDir(PathBuf);

impl ScratchDir {
    pub fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("betaclaw-route-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).expect("create scratch dir");
        Self(path)
    }

    pub fn path_string(&self, name: &str) -> String {
        self.0.join(name).to_string_lossy().into_owned()
    }
}

impl Drop for ScratchDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Gateway state whose stores all live inside `scratch`.
pub fn state_in(scratch: &ScratchDir) -> SharedState {
    state_with(scratch, |_| {})
}

/// Like [`state_in`], with a chance to adjust the configuration first.
pub fn state_with(scratch: &ScratchDir, configure: impl FnOnce(&mut GatewayConfig)) -> SharedState {
    let mut config = GatewayConfig::from_env().expect("test configuration resolves");
    config.logs_db_path = ":memory:".to_string();
    config.gateway_config_db_path = scratch.path_string("gateway-config.db");
    // Pinned so a developer's BETACLAW_CONFIG_BACKEND cannot leak into the tests.
    config.gateway_config_backend = ConfigBackend::Db;
    config.gateway_config_path = scratch.path_string("betaclaw.json");
    config.personas_db_path = scratch.path_string("personas.db");
    config.personas_root_path = scratch.path_string("personas");
    config.messages_db_path = scratch.path_string("messages.db");
    // Accept and drop, so a proxied request fails at once with 502.
    config.upstream_origin = upstream_stub();
    configure(&mut config);
    std::sync::Arc::new(AppState::new(config).expect("state initialises"))
}

/// Binds a local upstream that accepts each connection and drops it at once,
/// so a proxied request gets a connection error straight away. The accept task
/// lives on the calling test's Tokio runtime, so this must run inside one; every
/// caller is a `#[tokio::test]`.
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

/// Sends one request through the migrated routes and returns status and JSON body.
pub async fn send(
    state: &SharedState,
    method: Method,
    uri: &str,
    user: Option<&str>,
    body: Option<&str>,
) -> (StatusCode, Value) {
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
    let response = crate::routes::router()
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
