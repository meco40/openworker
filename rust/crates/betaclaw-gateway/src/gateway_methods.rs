//! Gateway RPC method registry.
//!
//! Ports the method-router contract from `src/server/gateway/method-router.ts`.
//! Two kinds of method are registered: the native S1 methods (`presence.*` and
//! `logs.*`), which read the gateway state directly, and the family methods of
//! `families::ws_wire`, which carry their own services and reply asynchronously.

use std::collections::HashMap;
use std::sync::Arc;

use betaclaw_core::gateway::client::{ClientHandle, RequestWindow};
use betaclaw_core::gateway::events::LOG_ENTRY;
use betaclaw_core::gateway::protocol::{
    invalid_frame_error, make_error, make_response, ErrorCode, FrameId, GatewayFrame,
};
use betaclaw_core::gateway::registry::ClientRegistry;
use betaclaw_core::logging::repository::{LogFilter, LogLevel};
use serde_json::Value;

#[cfg(test)]
use betaclaw_core::logging::repository::LogCategory;

use crate::families::ws_wire::{WsCall, WsHandler};
use crate::families::{wiring, ws_wire};
use crate::state::SharedState;

/// Result of a method invocation.
pub enum MethodOutcome {
    /// A single response frame with this payload.
    Payload(Value),
    /// No response; the handler wrote frames itself.
    Silent,
    /// An error with a specific code.
    Failed(ErrorCode, String),
}

/// Handler signature of the native methods. `respond` mirrors the TypeScript `RespondFn`.
pub type MethodHandler =
    Arc<dyn Fn(&Value, &ClientHandle, &SharedState) -> MethodOutcome + Send + Sync>;

/// A registered method. Native handlers read the gateway state, family handlers carry
/// their own services.
enum Handler {
    Native(MethodHandler),
    Family(WsHandler),
}

#[derive(Default)]
pub struct MethodRegistry {
    handlers: HashMap<String, Handler>,
}

impl MethodRegistry {
    pub fn new() -> Self {
        Self {
            handlers: HashMap::new(),
        }
    }

    pub fn register(&mut self, method: &str, handler: MethodHandler) {
        self.handlers
            .insert(method.to_string(), Handler::Native(handler));
    }

    /// Registers a method that a family serves with its own services.
    pub fn register_family(&mut self, method: &str, handler: WsHandler) {
        self.handlers
            .insert(method.to_string(), Handler::Family(handler));
    }

    /// Registered method names, sorted. The order feeds the `hello-ok` payload,
    /// and a stable order keeps the payload byte-identical across restarts.
    pub fn method_names(&self) -> Vec<String> {
        let mut names: Vec<String> = self.handlers.keys().cloned().collect();
        names.sort();
        names
    }

    /// Answers one request. `None` means the handler already wrote its own frames
    /// (a streamed reply), so nothing is sent.
    pub async fn dispatch(
        &self,
        frame_id: &FrameId,
        method: &str,
        params: &Value,
        client: &ClientHandle,
        state: &SharedState,
    ) -> Option<Value> {
        let Some(handler) = self.handlers.get(method) else {
            // Not registered in this process. The reply itself stays byte-identical to
            // `method-router.ts`, but without a log line the resulting client failure is
            // invisible in production.
            tracing::warn!(
                method,
                user_id = %client.user_id,
                "Gateway method is not registered in the Rust gateway"
            );
            return Some(make_error(
                frame_id,
                ErrorCode::InvalidRequest,
                &format!("Unknown method: {method}"),
            ));
        };
        match handler {
            Handler::Native(handler) => Some(match handler(params, client, state) {
                MethodOutcome::Payload(payload) => make_response(frame_id, payload),
                MethodOutcome::Silent => {
                    make_error(frame_id, ErrorCode::Unavailable, "Internal server error")
                }
                MethodOutcome::Failed(code, message) => make_error(frame_id, code, &message),
            }),
            Handler::Family(handler) => {
                let call = WsCall {
                    id: frame_id.clone(),
                    params: params.clone(),
                    client: client.clone(),
                };
                handler(call).await.into_frame(frame_id)
            }
        }
    }
}

/// Builds the registry for one connection: the native S1 methods and the WS family's
/// method table, wired to the gateway state.
pub fn build_registry(state: &SharedState) -> MethodRegistry {
    let mut registry = MethodRegistry::new();

    registry.register("presence.list", Arc::new(presence_list));
    registry.register("presence.whoami", Arc::new(presence_whoami));

    registry.register("logs.list", Arc::new(logs_list));
    registry.register("logs.subscribe", Arc::new(logs_subscribe));
    registry.register("logs.unsubscribe", Arc::new(logs_unsubscribe));
    registry.register("logs.sources", Arc::new(logs_sources));
    registry.register("logs.categories", Arc::new(logs_categories));
    registry.register("logs.clear", Arc::new(logs_clear));

    let services = Arc::new(wiring::ws_services(state));
    for (method, handler) in ws_wire::method_table(services) {
        registry.register_family(method, handler);
    }

    registry
}

/// `presence.list` — port of `methods/presence.ts:11-29`.
fn presence_list(_params: &Value, _client: &ClientHandle, state: &SharedState) -> MethodOutcome {
    let users: Vec<Value> = state
        .registry
        .distinct_users()
        .into_iter()
        .map(|(user_id, connections)| serde_json::json!({ "userId": user_id, "connections": connections }))
        .collect();
    MethodOutcome::Payload(Value::Array(users))
}

/// `presence.whoami` — port of `methods/presence.ts:31-44`.
fn presence_whoami(_params: &Value, client: &ClientHandle, _state: &SharedState) -> MethodOutcome {
    MethodOutcome::Payload(serde_json::json!({
        "connId": client.conn_id.as_ref(),
        "userId": client.user_id.as_ref(),
        "connectedAt": client.connected_at(),
        "subscriptions": client.subscriptions(),
    }))
}

/// `logs.list` — port of `methods/logs.ts:10-26`.
fn logs_list(params: &Value, _client: &ClientHandle, state: &SharedState) -> MethodOutcome {
    let filter = LogFilter {
        level: params
            .get("level")
            .and_then(Value::as_str)
            .and_then(LogLevel::parse),
        source: params
            .get("source")
            .and_then(Value::as_str)
            .map(str::to_string),
        category: params
            .get("category")
            .and_then(Value::as_str)
            .and_then(betaclaw_core::logging::repository::LogCategory::parse),
        search: params
            .get("search")
            .and_then(Value::as_str)
            .map(str::to_string),
        limit: params
            .get("limit")
            .and_then(Value::as_i64)
            .filter(|value| *value > 0)
            .map(|value| value as usize),
        before: params
            .get("before")
            .and_then(Value::as_str)
            .map(str::to_string),
    };

    let guard = match state.logs.try_lock() {
        Ok(guard) => guard,
        Err(_) => {
            return MethodOutcome::Failed(ErrorCode::Unavailable, "Log repository is busy".into())
        }
    };
    match guard.list_logs(&filter) {
        Ok(entries) => MethodOutcome::Payload(
            serde_json::to_value(entries).unwrap_or(Value::Array(Vec::new())),
        ),
        Err(error) => MethodOutcome::Failed(ErrorCode::Unavailable, error.to_string()),
    }
}

/// `logs.subscribe` — port of `methods/logs.ts:29-43`.
fn logs_subscribe(params: &Value, client: &ClientHandle, _state: &SharedState) -> MethodOutcome {
    let level = params.get("level").and_then(Value::as_str);
    let source = params.get("source").and_then(Value::as_str);
    let key = subscription_key(level, source);
    client.add_subscription(key);
    MethodOutcome::Payload(serde_json::json!({
        "subscribed": true,
        "filter": { "level": level, "source": source },
    }))
}

/// `logs.unsubscribe` — port of `methods/logs.ts:46-58`.
fn logs_unsubscribe(_params: &Value, client: &ClientHandle, _state: &SharedState) -> MethodOutcome {
    for key in client.subscriptions() {
        if key == "logs" || key.starts_with("logs:") {
            client.remove_subscription(&key);
        }
    }
    MethodOutcome::Payload(serde_json::json!({ "unsubscribed": true }))
}

fn subscription_key(level: Option<&str>, source: Option<&str>) -> String {
    match (level, source) {
        (None, None) => "logs".to_string(),
        (level, source) => format!("logs:{}:{}", level.unwrap_or("*"), source.unwrap_or("*")),
    }
}

/// `logs.sources` — port of `methods/logs.ts:61-70`.
fn logs_sources(_params: &Value, _client: &ClientHandle, state: &SharedState) -> MethodOutcome {
    let guard = match state.logs.try_lock() {
        Ok(guard) => guard,
        Err(_) => {
            return MethodOutcome::Failed(ErrorCode::Unavailable, "Log repository is busy".into())
        }
    };
    match guard.get_sources() {
        Ok(sources) => MethodOutcome::Payload(serde_json::to_value(sources).unwrap_or(Value::Null)),
        Err(error) => MethodOutcome::Failed(ErrorCode::Unavailable, error.to_string()),
    }
}

/// `logs.categories` — port of `methods/logs.ts:73-82`.
fn logs_categories(_params: &Value, _client: &ClientHandle, state: &SharedState) -> MethodOutcome {
    let guard = match state.logs.try_lock() {
        Ok(guard) => guard,
        Err(_) => {
            return MethodOutcome::Failed(ErrorCode::Unavailable, "Log repository is busy".into())
        }
    };
    match guard.get_categories() {
        Ok(categories) => {
            MethodOutcome::Payload(serde_json::to_value(categories).unwrap_or(Value::Null))
        }
        Err(error) => MethodOutcome::Failed(ErrorCode::Unavailable, error.to_string()),
    }
}

/// `logs.clear` — port of `methods/logs.ts:85-93`.
fn logs_clear(_params: &Value, _client: &ClientHandle, state: &SharedState) -> MethodOutcome {
    let guard = match state.logs.try_lock() {
        Ok(guard) => guard,
        Err(_) => {
            return MethodOutcome::Failed(ErrorCode::Unavailable, "Log repository is busy".into())
        }
    };
    match guard.clear_logs() {
        Ok(cleared) => MethodOutcome::Payload(serde_json::json!({ "cleared": cleared })),
        Err(error) => MethodOutcome::Failed(ErrorCode::Unavailable, error.to_string()),
    }
}

/// Logs a gateway-internal event and fans it out to subscribed clients.
pub fn emit_log(state: &SharedState, level: LogLevel, source: &str, message: &str) {
    let category = betaclaw_core::logging::resolve_category(source);
    let Ok(guard) = state.logs.try_lock() else {
        return;
    };
    let result = betaclaw_core::logging::log(
        &guard,
        Some(&state.registry),
        level,
        source,
        message,
        None,
        Some(category),
    );
    drop(guard);
    if let Err(error) = result {
        tracing::warn!(error = %error, "Failed to persist gateway log entry");
    }
}

/// Broadcast event name used when a log entry is fanned out.
pub const LOG_EVENT: &str = LOG_ENTRY;

/// The methods that the WS family serves through `ws_wire::method_table`. The family
/// pins this list in its own test, so the name stays. Together with the native
/// `presence.*` and `logs.*` methods they make up the full surface of 38.
pub fn pending_methods() -> &'static [&'static str] {
    &[
        "agent.v2.session.start",
        "agent.v2.session.input",
        "agent.v2.session.steer",
        "agent.v2.session.follow_up",
        "agent.v2.session.approval.respond",
        "agent.v2.session.abort",
        "agent.v2.session.get",
        "agent.v2.session.list",
        "agent.v2.session.replay",
        "agent.v2.swarm.create",
        "agent.v2.swarm.list",
        "agent.v2.swarm.get",
        "agent.v2.swarm.update",
        "agent.v2.swarm.delete",
        "agent.v2.swarm.fork",
        "agent.v2.swarm.chain",
        "agent.v2.swarm.deploy",
        "channels.list",
        "channels.pair",
        "channels.unpair",
        "chat.abort",
        "chat.approval.respond",
        "chat.conversations.list",
        "chat.history",
        "chat.send",
        "chat.stream",
        "inbox.list",
        "sessions.delete",
        "sessions.patch",
        "sessions.reset",
    ]
}

/// Builds the `hello-ok` payload. Port of the object in
/// `connection-handler.ts:40-45`.
///
/// The registry is accepted so the payload can later report live connection
/// counts without changing the call site; the S1 contract does not include one.
pub fn hello_ok_payload(methods: &MethodRegistry, _registry: &ClientRegistry) -> Value {
    serde_json::json!({
        "server": { "version": betaclaw_core::gateway::GATEWAY_VERSION },
        "events": betaclaw_core::gateway::GATEWAY_EVENTS,
        "methods": methods.method_names(),
    })
}

/// Frames that are not requests are ignored, matching the TypeScript handler.
pub fn is_dispatchable(frame: &GatewayFrame) -> bool {
    matches!(frame, GatewayFrame::Request(_))
}

/// Frame emitted when the per-connection request budget is exhausted.
pub fn rate_limited(frame_id: &FrameId) -> Value {
    make_error(frame_id, ErrorCode::RateLimited, "Too many requests")
}

/// Frame emitted when the client exceeds the connection cap.
pub fn too_many_connections() -> &'static str {
    "HTTP/1.1 429 Too Many Connections\r\n\r\n"
}

/// Response used when the session cookie is missing or invalid.
pub fn unauthorized() -> &'static str {
    "HTTP/1.1 401 Unauthorized\r\n\r\n"
}

/// Response used when a browser opens the socket cross-site.
pub fn forbidden() -> &'static str {
    "HTTP/1.1 403 Forbidden\r\n\r\n"
}

/// Response used when `protocol=v2` is absent.
pub fn bad_request() -> &'static str {
    "HTTP/1.1 400 Bad Request\r\n\r\n"
}

/// Response used for any upgrade on a path other than `/ws`.
pub fn not_found() -> &'static str {
    "HTTP/1.1 404 Not Found\r\n\r\n"
}

/// Response used when the upgrade handler itself fails.
pub fn internal_error() -> &'static str {
    "HTTP/1.1 500 Internal Server Error\r\n\r\n"
}

/// Creates a per-connection request window.
pub fn new_request_window(now_ms: u64) -> RequestWindow {
    RequestWindow::new(now_ms)
}

/// Re-exported so route modules can name the category type.
pub use betaclaw_core::logging::repository::LogCategory as GatewayLogCategory;

/// Keeps `invalid_frame_error` reachable from the router tests.
pub fn invalid_frame() -> Value {
    invalid_frame_error()
}

#[cfg(test)]
mod tests {
    use super::*;
    use betaclaw_core::gateway::client::ClientHandle;
    use betaclaw_core::logging::repository::LogRepository;

    async fn fixture() -> SharedState {
        let mut config = betaclaw_core::config::GatewayConfig::from_env().unwrap();
        config.logs_db_path = ":memory:".to_string();
        config.personas_db_path = ":memory:".to_string();
        config.messages_db_path = ":memory:".to_string();
        let state = crate::state::AppState::new(config).unwrap();
        std::sync::Arc::new(state)
    }

    fn handle(name: &str) -> ClientHandle {
        let (tx, _rx) = tokio::sync::mpsc::channel(32);
        ClientHandle::new(name, "u1", "v2", 1_700_000_000, tx)
    }

    /// Dispatches one request and returns its reply. Every method these tests call is
    /// registered, so the reply is always present.
    async fn call(
        registry: &MethodRegistry,
        state: &SharedState,
        client: &ClientHandle,
        frame: FrameId,
        method: &str,
        params: Value,
    ) -> Value {
        registry
            .dispatch(&frame, method, &params, client, state)
            .await
            .expect("a registered method answers")
    }

    #[tokio::test]
    async fn unknown_method_returns_invalid_request() {
        let state = fixture().await;
        let registry = build_registry(&state);
        let response = call(
            &registry,
            &state,
            &handle("c0"),
            FrameId::number(1),
            "no.such.method",
            Value::Null,
        )
        .await;
        assert_eq!(response["ok"], false);
        assert_eq!(response["error"]["code"], "INVALID_REQUEST");
        assert_eq!(
            response["error"]["message"],
            "Unknown method: no.such.method"
        );
    }

    #[tokio::test]
    async fn presence_methods_report_registry_state() {
        let state = fixture().await;
        let registry = build_registry(&state);
        let client = handle("c0");
        client.add_subscription("logs");
        state.registry.register(client.clone());

        let response = call(
            &registry,
            &state,
            &client,
            FrameId::Str("a".into()),
            "presence.list",
            Value::Null,
        )
        .await;
        assert_eq!(response["ok"], true);
        assert_eq!(response["payload"][0]["userId"], "u1");
        assert_eq!(response["payload"][0]["connections"], 1);

        let response = call(
            &registry,
            &state,
            &client,
            FrameId::Str("b".into()),
            "presence.whoami",
            Value::Null,
        )
        .await;
        assert_eq!(response["payload"]["connId"], "c0");
        assert_eq!(response["payload"]["userId"], "u1");
        assert_eq!(response["payload"]["connectedAt"], 1_700_000_000);
        assert_eq!(response["payload"]["subscriptions"][0], "logs");
    }

    #[tokio::test]
    async fn logs_lifecycle() {
        let state = fixture().await;
        let registry = build_registry(&state);
        let client = handle("c0");

        {
            let guard = state.logs.try_lock().unwrap();
            guard
                .insert_log(LogLevel::Info, "SYS", "boot", None, LogCategory::System)
                .unwrap();
        }

        let response = call(
            &registry,
            &state,
            &client,
            FrameId::number(1),
            "logs.list",
            Value::Null,
        )
        .await;
        assert_eq!(response["payload"].as_array().unwrap().len(), 1);

        let response = call(
            &registry,
            &state,
            &client,
            FrameId::number(2),
            "logs.sources",
            Value::Null,
        )
        .await;
        assert_eq!(response["payload"][0], "SYS");

        let response = call(
            &registry,
            &state,
            &client,
            FrameId::number(3),
            "logs.categories",
            Value::Null,
        )
        .await;
        assert_eq!(response["payload"][0], "system");

        let subscribe = call(
            &registry,
            &state,
            &client,
            FrameId::number(4),
            "logs.subscribe",
            serde_json::json!({"level": "error"}),
        )
        .await;
        assert_eq!(subscribe["payload"]["subscribed"], true);
        assert!(client.has_subscription("logs:error:*"));

        let response = call(
            &registry,
            &state,
            &client,
            FrameId::number(5),
            "logs.unsubscribe",
            Value::Null,
        )
        .await;
        assert_eq!(response["payload"]["unsubscribed"], true);
        assert!(!client.has_subscription("logs:error:*"));

        let response = call(
            &registry,
            &state,
            &client,
            FrameId::number(6),
            "logs.clear",
            Value::Null,
        )
        .await;
        assert_eq!(response["payload"]["cleared"], 1);
    }

    #[tokio::test]
    async fn hello_ok_lists_methods_sorted() {
        let state = fixture().await;
        let registry = build_registry(&state);
        let payload = hello_ok_payload(&registry, &state.registry);
        let methods = payload["methods"].as_array().unwrap();
        assert_eq!(methods.len(), 38);
        assert_eq!(methods[0], "agent.v2.session.abort");
        assert_eq!(payload["server"]["version"], "1.0.0");
        assert_eq!(payload["events"].as_array().unwrap().len(), 29);

        let mut sorted = methods.clone();
        sorted.sort_by(|a, b| a.as_str().unwrap().cmp(b.as_str().unwrap()));
        assert_eq!(sorted, methods.to_vec(), "method list must be sorted");
    }

    #[tokio::test]
    async fn family_methods_join_the_native_ones() {
        let state = fixture().await;
        let registered = build_registry(&state).method_names();
        // 8 native methods (presence.*, logs.*) plus the 30 that the WS family serves.
        assert_eq!(registered.len(), 38);
        assert_eq!(pending_methods().len(), 30);
        for pending in pending_methods() {
            assert!(
                registered.iter().any(|name| name == pending),
                "{pending} must be registered"
            );
        }
    }

    /// The complete method surface, sorted. Regenerate this list with the same
    /// command documented in docs/RUST_MIGRATION.md whenever a slice moves a
    /// method between the two implementations.
    const FULL_METHOD_SURFACE: &[&str] = &[
        "agent.v2.session.abort",
        "agent.v2.session.approval.respond",
        "agent.v2.session.follow_up",
        "agent.v2.session.get",
        "agent.v2.session.input",
        "agent.v2.session.list",
        "agent.v2.session.replay",
        "agent.v2.session.start",
        "agent.v2.session.steer",
        "agent.v2.swarm.chain",
        "agent.v2.swarm.create",
        "agent.v2.swarm.delete",
        "agent.v2.swarm.deploy",
        "agent.v2.swarm.fork",
        "agent.v2.swarm.get",
        "agent.v2.swarm.list",
        "agent.v2.swarm.update",
        "channels.list",
        "channels.pair",
        "channels.unpair",
        "chat.abort",
        "chat.approval.respond",
        "chat.conversations.list",
        "chat.history",
        "chat.send",
        "chat.stream",
        "inbox.list",
        "logs.categories",
        "logs.clear",
        "logs.list",
        "logs.sources",
        "logs.subscribe",
        "logs.unsubscribe",
        "presence.list",
        "presence.whoami",
        "sessions.delete",
        "sessions.patch",
        "sessions.reset",
    ];

    #[tokio::test]
    async fn method_surface_matches_the_typescript_registry() {
        let state = fixture().await;
        let all = build_registry(&state).method_names();

        let mut expected: Vec<String> = FULL_METHOD_SURFACE
            .iter()
            .map(|name| name.to_string())
            .collect();
        expected.sort();

        assert_eq!(all, expected);
        assert_eq!(expected.len(), 38);
    }

    #[test]
    fn subscription_keys_match_typescript() {
        assert_eq!(subscription_key(None, None), "logs");
        assert_eq!(subscription_key(Some("error"), None), "logs:error:*");
        assert_eq!(subscription_key(None, Some("SYS")), "logs:*:SYS");
        assert_eq!(
            subscription_key(Some("error"), Some("SYS")),
            "logs:error:SYS"
        );
    }

    #[test]
    fn rate_limit_frame_shape() {
        let frame = rate_limited(&FrameId::number(3));
        assert_eq!(frame["type"], "res");
        assert_eq!(frame["ok"], false);
        assert_eq!(frame["error"]["code"], "RATE_LIMITED");
    }

    #[tokio::test]
    async fn emit_log_persists_and_broadcasts() {
        let state = fixture().await;
        let (tx, mut rx) = tokio::sync::mpsc::channel(4);
        state
            .registry
            .register(ClientHandle::new("c0", "u1", "v2", 0, tx));
        state.registry.get("c0").unwrap().add_subscription("logs");

        emit_log(&state, LogLevel::Warn, "GATEWAY", "something happened");
        let message = rx.try_recv().expect("expected broadcast");
        match message {
            betaclaw_core::gateway::client::Outbound::Text(text) => {
                let frame = betaclaw_core::gateway::protocol::parse_frame(&text).unwrap();
                assert_eq!(frame_event_name(&frame), Some(LOG_EVENT));
            }
            other => panic!("unexpected outbound {other:?}"),
        }
        let guard = state.logs.try_lock().unwrap();
        assert_eq!(guard.get_log_count(&LogFilter::default()).unwrap(), 1);
    }

    fn frame_event_name(frame: &GatewayFrame) -> Option<&str> {
        match frame {
            GatewayFrame::Event(event) => Some(event.event.as_str()),
            _ => None,
        }
    }

    #[test]
    fn log_repository_opens_in_memory() {
        assert!(LogRepository::open(":memory:").is_ok());
    }
}
