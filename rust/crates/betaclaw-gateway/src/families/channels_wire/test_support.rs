//! Harness for the channel-family tests. Compiled for `cargo test` only.
//!
//! [`harness`] builds the gateway state and the channel services on one scratch
//! directory, so a test and its route see the same stores. The HTTP port answers
//! from a table, and the chat dispatch records what it receives.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, PoisonError};

use axum::body::{Body, Bytes};
use axum::http::{HeaderMap, Method, Request, StatusCode};
use axum::{Extension, Router};
use betaclaw_core::channels::messages::service::execution::ports::{PortError, PortResult};
use betaclaw_core::channels::messages::service::inbound::handle_inbound::{
    InboundParams, InboundResult,
};
use betaclaw_core::config::GatewayConfig;
use betaclaw_core::gateway_config::ConfigBackend;
use betaclaw_core::messages_store::now_iso;
use betaclaw_core::messages_store::types::{ChannelType, StoredMessage};
use betaclaw_core::model_hub::http::{
    BoxFuture, HttpError, HttpRequest, HttpResponse, HttpTransport,
};
use serde_json::Value;
use tower::ServiceExt;

use super::{build, ChannelInbound, Services};
use crate::state::{AppState, SharedState};

pub const USER: &str = "user-channels";

/// A scratch directory under the system temp dir, removed when dropped.
pub struct ScratchDir(PathBuf);

impl ScratchDir {
    pub fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("betaclaw-channels-test-{}", uuid::Uuid::new_v4()));
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

/// Configuration whose stores all live inside `scratch`.
pub fn config_in(scratch: &ScratchDir) -> GatewayConfig {
    let mut config = GatewayConfig::from_env().expect("test configuration resolves");
    config.logs_db_path = ":memory:".to_string();
    config.gateway_config_db_path = scratch.path_string("gateway-config.db");
    config.gateway_config_backend = ConfigBackend::Db;
    config.gateway_config_path = scratch.path_string("betaclaw.json");
    config.personas_db_path = scratch.path_string("personas.db");
    config.personas_root_path = scratch.path_string("personas");
    config.messages_db_path = scratch.path_string("messages.db");
    config
}

pub fn state_in(scratch: &ScratchDir) -> SharedState {
    Arc::new(AppState::new(config_in(scratch)).expect("state initialises"))
}

/// The HTTP port of the tests. Every request fails, as an unreachable provider
/// would; the tests cover paths that finish before any provider call.
pub struct NoNetworkTransport;

impl HttpTransport for NoNetworkTransport {
    fn send<'a>(&'a self, request: HttpRequest) -> BoxFuture<'a, Result<HttpResponse, HttpError>> {
        Box::pin(async move {
            Err(HttpError::Transport(format!(
                "no network in tests: {}",
                request.url
            )))
        })
    }
}

/// Answers outbound requests from a queue, in call order, and keeps every request
/// for the assertions. A call with an empty queue fails, as an unreachable host does.
#[derive(Default)]
pub struct ScriptedHttp {
    responses: Mutex<VecDeque<Result<HttpResponse, HttpError>>>,
    requests: Mutex<Vec<HttpRequest>>,
}

impl ScriptedHttp {
    pub fn with(responses: Vec<Result<HttpResponse, HttpError>>) -> Arc<Self> {
        Arc::new(Self {
            responses: Mutex::new(responses.into()),
            requests: Mutex::default(),
        })
    }

    pub fn requests(&self) -> Vec<HttpRequest> {
        self.requests
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    pub fn urls(&self) -> Vec<String> {
        self.requests()
            .into_iter()
            .map(|request| request.url)
            .collect()
    }
}

impl HttpTransport for ScriptedHttp {
    fn send<'a>(&'a self, request: HttpRequest) -> BoxFuture<'a, Result<HttpResponse, HttpError>> {
        Box::pin(async move {
            let url = request.url.clone();
            self.requests
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .push(request);
            self.responses
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .pop_front()
                .unwrap_or_else(|| {
                    Err(HttpError::Transport(format!(
                        "no scripted answer for {url}"
                    )))
                })
        })
    }
}

/// `{ ok: true, result: { message_id } }`, the answer of Telegram's send methods.
pub fn telegram_ok(message_id: i64) -> Result<HttpResponse, HttpError> {
    Ok(HttpResponse::json(
        StatusCode::OK,
        &serde_json::json!({"ok": true, "result": {"message_id": message_id}}),
    ))
}

/// One call of the chat dispatch, as the route handed it over.
#[derive(Debug, Clone, PartialEq)]
pub struct Recorded {
    pub platform: ChannelType,
    pub external_chat_id: String,
    pub content: String,
    pub sender_name: Option<String>,
    pub external_msg_id: Option<String>,
    pub user_id: Option<String>,
    pub client_message_id: Option<String>,
    pub attachment_metadata: Option<Value>,
}

/// Records the calls and answers with two stored messages. With `fail` set, it
/// refuses every call.
#[derive(Default)]
pub struct FakeInbound {
    pub calls: Mutex<Vec<Recorded>>,
    pub fail: bool,
}

impl ChannelInbound for FakeInbound {
    fn handle_inbound(&self, params: InboundParams) -> BoxFuture<'_, PortResult<InboundResult>> {
        Box::pin(async move {
            let record = Recorded {
                platform: params.platform,
                external_chat_id: params.external_chat_id.clone(),
                content: params.content.clone(),
                sender_name: params.sender_name.clone(),
                external_msg_id: params.external_msg_id.clone(),
                user_id: params.user_id.clone(),
                client_message_id: params.client_message_id.clone(),
                attachment_metadata: params.attachment_metadata.clone(),
            };
            self.calls
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .push(record);
            if self.fail {
                return Err(PortError::Failed("dispatch refused".to_string()));
            }
            Ok(InboundResult {
                user_msg: stored("u-1", "user", &params.content),
                agent_msg: stored("a-1", "assistant", "reply"),
                new_conversation_id: None,
            })
        })
    }
}

fn stored(id: &str, role: &str, content: &str) -> StoredMessage {
    StoredMessage {
        id: id.to_string(),
        conversation_id: "conv".to_string(),
        seq: Some(1),
        role: role.to_string(),
        content: content.to_string(),
        platform: "WebChat".to_string(),
        external_msg_id: None,
        sender_name: None,
        metadata: None,
        created_at: now_iso(),
    }
}

/// The gateway state, the services and the router that serves the family.
pub struct Harness {
    pub app: Router,
    pub state: SharedState,
    pub services: Arc<Services>,
    pub inbound: Arc<FakeInbound>,
}

pub fn harness(scratch: &ScratchDir) -> Harness {
    harness_with(scratch, FakeInbound::default())
}

pub fn harness_with(scratch: &ScratchDir, inbound: FakeInbound) -> Harness {
    harness_on(scratch, inbound, Arc::new(NoNetworkTransport))
}

/// A harness whose outbound HTTP goes to `transport`.
pub fn harness_on(
    scratch: &ScratchDir,
    inbound: FakeInbound,
    transport: Arc<dyn HttpTransport>,
) -> Harness {
    let state = state_in(scratch);
    let inbound = Arc::new(inbound);
    let services =
        Arc::new(build(state.clone(), transport, inbound.clone()).expect("channel services"));
    let app = super::router()
        .layer(Extension(services.clone()))
        .with_state(state.clone());
    Harness {
        app,
        state,
        services,
        inbound,
    }
}

impl Harness {
    /// Sends one request with the user header the auth gate would set, and
    /// returns status and JSON body.
    pub async fn send(
        &self,
        method: Method,
        uri: &str,
        user: Option<&str>,
        body: Option<&str>,
    ) -> (StatusCode, Value) {
        let mut headers: Vec<(&str, &str)> = Vec::new();
        if let Some(user) = user {
            headers.push(("x-betaclaw-user-id", user));
        }
        let (status, _, bytes) = self.raw(method, uri, &headers, body).await;
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    /// Like [`Harness::send`], with explicit headers and no user.
    pub async fn send_with_headers(
        &self,
        method: Method,
        uri: &str,
        headers: &[(&str, &str)],
        body: Option<&str>,
    ) -> (StatusCode, Value) {
        let (status, _, bytes) = self.raw(method, uri, headers, body).await;
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    /// Sends one request with explicit headers and returns status, headers and body bytes.
    pub async fn raw(
        &self,
        method: Method,
        uri: &str,
        headers: &[(&str, &str)],
        body: Option<&str>,
    ) -> (StatusCode, HeaderMap, Bytes) {
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
        let response = self
            .app
            .clone()
            .oneshot(request)
            .await
            .expect("infallible service");
        let status = response.status();
        let response_headers = response.headers().clone();
        let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
            .await
            .expect("read body");
        (status, response_headers, bytes)
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
