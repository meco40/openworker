//! Harness of the task family's route tests. Compiled for `cargo test` only.
//!
//! Each fixture owns a scratch directory with its own databases and task workspace
//! root. Requests go through the family's router, with the identity headers the
//! auth gate would set.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use axum::Extension;
use betaclaw_core::config::GatewayConfig;
use betaclaw_core::gateway_config::ConfigBackend;
use rusqlite::Connection;
use serde_json::Value;
use tower::ServiceExt;

use super::ports::{
    BetaClawRuntime, BoxFuture, NoSkills, RuntimeError, SkillInventory, UnwiredRuntime,
};
use super::{build, router, Services};
use crate::state::{AppState, SharedState};

/// The legacy `conversation_participants` and `messages` tables that `migration_runner`
/// creates in mission-control.db (`LEGACY_SCHEMA`).
pub const LEGACY_TABLES: &str = "
    CREATE TABLE IF NOT EXISTS conversation_participants (
      conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
      agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE,
      joined_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (conversation_id, agent_id)
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
      sender_agent_id TEXT REFERENCES agents(id),
      content TEXT NOT NULL,
      message_type TEXT DEFAULT 'text',
      metadata TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );";

/// A scratch directory under the system temp dir, removed when dropped.
pub struct ScratchDir(PathBuf);

impl ScratchDir {
    pub fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "betaclaw-tasks-test-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&path).expect("create scratch dir");
        Self(path)
    }

    pub fn path_string(&self, name: &str) -> String {
        self.0.join(name).to_string_lossy().into_owned()
    }
}

impl Default for ScratchDir {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for ScratchDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Gateway state and family services, both on the scratch directory.
pub struct Fixture {
    pub state: SharedState,
    pub services: Arc<Services>,
    _scratch: ScratchDir,
}

pub fn fixture() -> Fixture {
    fixture_with(Arc::new(UnwiredRuntime), Arc::new(NoSkills), |_| {})
}

/// Like [`fixture`], with the runtime and skills of the caller and a chance to adjust the
/// configuration. REQUIRE_AUTH is off unless `configure` turns it on.
pub fn fixture_with(
    runtime: Arc<dyn BetaClawRuntime>,
    skills: Arc<dyn SkillInventory>,
    configure: impl FnOnce(&mut GatewayConfig),
) -> Fixture {
    let scratch = ScratchDir::new();
    let mut config = GatewayConfig::from_env().expect("test configuration resolves");
    config.logs_db_path = ":memory:".to_string();
    config.gateway_config_db_path = scratch.path_string("gateway-config.db");
    config.gateway_config_backend = ConfigBackend::Db;
    config.gateway_config_path = scratch.path_string("betaclaw.json");
    config.personas_db_path = scratch.path_string("personas.db");
    config.personas_root_path = scratch.path_string("personas");
    config.messages_db_path = scratch.path_string("messages.db");
    config.require_auth = false;
    configure(&mut config);
    let state = Arc::new(AppState::new(config).expect("state initialises"));
    let services = build(
        &scratch.path_string("mission-control.db"),
        PathBuf::from(scratch.path_string("workspaces")),
        "/projects".to_string(),
        "http://localhost:3000".to_string(),
        runtime,
        skills,
    )
    .expect("services initialise");
    // `migration_runner` creates these two legacy tables in mission-control.db, and the
    // agent delete reads them, so the fixture creates them too.
    services
        .tasks
        .connection()
        .execute_batch(LEGACY_TABLES)
        .expect("legacy tables");
    Fixture {
        state,
        services: Arc::new(services),
        _scratch: scratch,
    }
}

/// Sends one request through the family's routes. `user` sets the identity header the gate
/// would set. Returns the status and the JSON body (`null` when the body is not JSON).
pub async fn send(
    fixture: &Fixture,
    method: Method,
    uri: &str,
    user: Option<&str>,
    body: Option<&str>,
) -> (StatusCode, Value) {
    let headers: Vec<(&str, &str)> = user
        .map(|user| vec![("x-betaclaw-user-id", user)])
        .unwrap_or_default();
    send_with(fixture, method, uri, &headers, body).await
}

/// Like [`send`], with explicit headers.
pub async fn send_with(
    fixture: &Fixture,
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
    let app = router()
        .layer(Extension(fixture.services.clone()))
        .with_state(fixture.state.clone());
    let response = app.oneshot(request).await.expect("infallible service");
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
        .await
        .expect("read body");
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

/// A connected runtime that answers the methods it was given and records every call.
/// Any other method answers `null`.
pub struct FakeRuntime {
    answers: Vec<(String, Value)>,
    calls: Mutex<Vec<(String, Value)>>,
}

impl FakeRuntime {
    pub fn answering(method: &str, value: Value) -> Self {
        Self {
            answers: vec![(method.to_string(), value)],
            calls: Mutex::new(Vec::new()),
        }
    }

    pub fn calls_to(&self, method: &str) -> usize {
        self.calls
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .iter()
            .filter(|(called, _)| called == method)
            .count()
    }
}

impl BetaClawRuntime for FakeRuntime {
    fn is_connected(&self) -> bool {
        true
    }

    fn connect(&self) -> BoxFuture<'_, Result<(), RuntimeError>> {
        Box::pin(async { Ok(()) })
    }

    fn call<'a>(
        &'a self,
        method: &'a str,
        params: Value,
    ) -> BoxFuture<'a, Result<Value, RuntimeError>> {
        self.calls
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push((method.to_string(), params));
        let answer = self
            .answers
            .iter()
            .find(|(name, _)| name == method)
            .map(|(_, value)| value.clone())
            .unwrap_or(Value::Null);
        Box::pin(async move { Ok(answer) })
    }
}

/// A fixed count of installed skills.
pub struct FixedSkills(pub usize);

impl SkillInventory for FixedSkills {
    fn installed_count(&self) -> Result<usize, String> {
        Ok(self.0)
    }
}

/// An in-memory database with the task and automation tables, for the access helpers.
pub fn memory_connection() -> Connection {
    let mut connection = Connection::open_in_memory().expect("open in-memory database");
    betaclaw_core::tasks::migrations::run_migrations(&mut connection).expect("run migrations");
    connection
}
