//! Harness for the skills_wire route tests. The gateway state and the family services
//! live under one scratch directory, and requests go through this family's router.
//! The harness of `routes` is private to that module, so the pieces needed here are
//! repeated.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::body::Body;
use axum::http::{HeaderMap, Method, Request, StatusCode};
use axum::Extension;
use betaclaw_core::config::GatewayConfig;
use betaclaw_core::gateway_config::ConfigBackend;
use betaclaw_core::model_hub::http::HttpTransport;
use betaclaw_core::personas::PersonaWorkspace;
use betaclaw_core::skills::exec_approval::ExecApprovalStore;
use betaclaw_core::skills::types::{SkillEnv, SkillExecConfig};
use serde_json::Value;
use tower::ServiceExt;

use super::{build, router, Services};
use crate::families::master::skills::CoreSkillDispatcher;
use crate::model_hub_transport::ReqwestTransport;
use crate::state::{AppState, SharedState};

pub const OWNER: &str = "user-1";

/// A scratch directory under the system temp dir, removed when dropped.
pub struct ScratchDir(PathBuf);

impl ScratchDir {
    pub fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("betaclaw-skills-wire-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).expect("create scratch dir");
        Self(path)
    }

    pub fn path(&self) -> PathBuf {
        self.0.clone()
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

/// Gateway state and family services, stored under `scratch`.
pub struct Harness {
    pub scratch: ScratchDir,
    pub state: SharedState,
    pub services: Arc<Services>,
}

pub fn harness() -> Harness {
    let scratch = ScratchDir::new();
    let state = state_in(&scratch);
    let transport: Arc<dyn HttpTransport + Send + Sync> = Arc::new(ReqwestTransport::new());
    let dispatcher = Arc::new(
        CoreSkillDispatcher::new(
            transport,
            None,
            SkillEnv {
                personas: PersonaWorkspace::new(scratch.path().join("personas")),
                approvals: ExecApprovalStore::new(scratch.path().join("exec-approvals.json")),
                // Pinned off, so a test never depends on the host environment.
                exec: SkillExecConfig::from_raw(Some("false"), None, None, None),
            },
        )
        .with_http_request_enabled(false),
    );
    let services = build(
        &scratch.path_string("skills.db"),
        &scratch.path_string("clawhub.db"),
        scratch.path(),
        scratch.path().join("exec-approvals.json"),
        dispatcher,
    )
    .expect("build services");
    Harness {
        scratch,
        state,
        services: Arc::new(services),
    }
}

fn state_in(scratch: &ScratchDir) -> SharedState {
    let mut config = GatewayConfig::from_env().expect("test configuration resolves");
    config.logs_db_path = ":memory:".to_string();
    config.gateway_config_db_path = scratch.path_string("gateway-config.db");
    // Pinned so a developer's BETACLAW_CONFIG_BACKEND cannot leak into the tests.
    config.gateway_config_backend = ConfigBackend::Db;
    config.gateway_config_path = scratch.path_string("betaclaw.json");
    config.personas_db_path = scratch.path_string("personas.db");
    config.personas_root_path = scratch.path_string("personas");
    config.messages_db_path = scratch.path_string("messages.db");
    config.upstream_origin = upstream_stub();
    Arc::new(AppState::new(config).expect("state initialises"))
}

/// Binds a local upstream that drops each connection at once, so a proxied request
/// fails with 502. Must run inside a Tokio runtime.
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

/// A response read back in full.
pub struct Reply {
    pub status: StatusCode,
    pub headers: HeaderMap,
    pub text: String,
}

impl Reply {
    pub fn json(&self) -> Value {
        serde_json::from_str(&self.text).unwrap_or(Value::Null)
    }
}

/// Sends one request through the family router.
pub async fn send(
    h: &Harness,
    method: Method,
    uri: &str,
    user: Option<&str>,
    body: Option<&str>,
) -> Reply {
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
    let response = router()
        .layer(Extension(h.services.clone()))
        .with_state(h.state.clone())
        .oneshot(request)
        .await
        .expect("infallible service");
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = axum::body::to_bytes(response.into_body(), 4 * 1024 * 1024)
        .await
        .expect("read body");
    Reply {
        status,
        headers,
        text: String::from_utf8_lossy(&bytes).into_owned(),
    }
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

/// Writes `content` to `path`, creating the parent folders.
pub fn write_file(path: &Path, content: &str) {
    std::fs::create_dir_all(path.parent().expect("parent folder")).expect("create folder");
    std::fs::write(path, content).expect("write file");
}

/// `/api/files/preview?path=<path>`, with the path percent-encoded.
pub fn preview_uri(path: &str) -> String {
    let mut url = reqwest::Url::parse("http://localhost/api/files/preview").expect("base url");
    url.query_pairs_mut().append_pair("path", path);
    format!("{}?{}", url.path(), url.query().unwrap_or_default())
}
