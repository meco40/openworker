//! WebSocket method table for the Rust gateway (integration phase).
//!
//! Serves the 30 methods that the TypeScript gateway still registers under
//! `src/server/gateway/methods/`. Names match `gateway_methods::pending_methods()`.
//!
//! | Method | TypeScript source | Handler | Error codes |
//! |---|---|---|---|
//! | `chat.send` | `chat.ts` | `core_methods::chat_send` | INVALID_REQUEST, UNAVAILABLE |
//! | `chat.stream` | `chat.ts` | `core_methods::chat_stream` | as `chat.send`; no `res` on success |
//! | `chat.abort` | `chat.ts` | `core_methods::chat_abort` | UNAVAILABLE |
//! | `chat.history` | `chat.ts` | `core_methods::chat_history` | UNAVAILABLE |
//! | `chat.conversations.list` | `chat.ts` | `core_methods::chat_conversations_list` | UNAVAILABLE |
//! | `chat.approval.respond` | `chat.ts` | `core_methods::chat_approval_respond` | UNAVAILABLE |
//! | `sessions.delete` | `sessions.ts` | `core_methods::sessions_delete` | UNAVAILABLE |
//! | `sessions.reset` | `sessions.ts` | `core_methods::sessions_reset` | UNAVAILABLE |
//! | `sessions.patch` | `sessions.ts` | `core_methods::sessions_patch` | UNAVAILABLE |
//! | `channels.list` | `channels.ts` | `core_methods::channels_list` | UNAVAILABLE |
//! | `channels.pair` | `channels.ts` | `core_methods::channels_pair` | UNAVAILABLE |
//! | `channels.unpair` | `channels.ts` | `core_methods::channels_unpair` | UNAVAILABLE |
//! | `inbox.list` | `channels.ts` | `inbox::inbox_list` | INVALID_REQUEST, UNAVAILABLE, RATE_LIMITED |
//! | `agent.v2.session.*` (9) | `agent-v2/registerSessionMethods.ts` | `core_methods::session_*` | INVALID_REQUEST, UNAVAILABLE |
//! | `agent.v2.swarm.*` (8) | `agent-v2/registerSwarmMethods.ts` | `swarm::swarm_*` | INVALID_REQUEST, NOT_FOUND, UNAVAILABLE |
//!
//! Wire rules from `method-router.ts`:
//! - success gives one `res` frame with the payload,
//! - failure gives one `res` frame with the error code,
//! - `chat.stream` writes its `stream` frames itself and sends no `res` on success
//!   ([`WsOutcome::Streamed`]).
//!
//! The handlers are async because the core ports return futures, so the dispatcher
//! that calls [`WsHandler`] has to be async too. Frames come from
//! [`WsOutcome::into_frame`], which returns `None` for `Streamed`.

pub mod ports;

mod core_methods;
mod inbox;
mod swarm;

#[cfg(test)]
mod test_support;

use std::sync::Arc;

use betaclaw_core::channels::ws::helpers::HandlerError;
use betaclaw_core::channels::ws::ports::{
    AgentV2Sessions, BoxFuture, ChannelPairing, EventSink, MessageService, MessageStore,
    PersonaStore,
};
use betaclaw_core::gateway::client::ClientHandle;
use betaclaw_core::gateway::protocol::{make_response, FrameId};
use serde_json::Value;

use self::ports::{InboxRateLimit, InboxStore, SwarmStore};

/// The family services the WS handlers call. The integrator fills the fields from
/// the family services.
pub struct WsServices {
    pub messages: Arc<dyn MessageService>,
    pub store: Arc<dyn MessageStore>,
    pub personas: Arc<dyn PersonaStore>,
    pub pairing: Arc<dyn ChannelPairing>,
    pub sessions: Arc<dyn AgentV2Sessions>,
    pub events: Arc<dyn EventSink>,
    pub swarms: Arc<dyn SwarmStore>,
    pub inbox: Arc<dyn InboxStore>,
    pub inbox_rate_limit: Arc<dyn InboxRateLimit>,
}

/// One request, as a handler sees it.
pub struct WsCall {
    pub id: FrameId,
    pub params: Value,
    pub client: ClientHandle,
}

impl WsCall {
    /// `client.userId`.
    pub fn user_id(&self) -> &str {
        self.client.user_id.as_ref()
    }
}

/// What a handler produced. [`WsOutcome::into_frame`] turns it into a frame.
#[derive(Debug, Clone, PartialEq)]
pub enum WsOutcome {
    /// One `res` frame with this payload.
    Payload(Value),
    /// One `res` frame with this error code and message.
    Failed(HandlerError),
    /// The handler wrote its own `stream` frames and sends no `res`.
    Streamed,
}

impl WsOutcome {
    /// The frame that `method-router.ts` sends for this outcome, or `None` when the
    /// handler has already written its frames.
    pub fn into_frame(self, id: &FrameId) -> Option<Value> {
        match self {
            WsOutcome::Payload(payload) => Some(make_response(id, payload)),
            WsOutcome::Failed(error) => Some(error.to_frame(id)),
            WsOutcome::Streamed => None,
        }
    }
}

impl From<Result<Value, HandlerError>> for WsOutcome {
    fn from(result: Result<Value, HandlerError>) -> Self {
        match result {
            Ok(payload) => WsOutcome::Payload(payload),
            Err(error) => WsOutcome::Failed(error),
        }
    }
}

/// The future a handler returns.
pub type WsFuture = BoxFuture<'static, WsOutcome>;

/// A registered WS method.
pub type WsHandler = Arc<dyn Fn(WsCall) -> WsFuture + Send + Sync>;

/// Builds the 30 WS methods that the TypeScript gateway still serves.
pub fn method_table(services: Arc<WsServices>) -> Vec<(&'static str, WsHandler)> {
    let s = &services;
    vec![
        (
            "agent.v2.session.start",
            bind_async(s, core_methods::session_start),
        ),
        (
            "agent.v2.session.input",
            bind_async(s, core_methods::session_input),
        ),
        (
            "agent.v2.session.steer",
            bind_async(s, core_methods::session_steer),
        ),
        (
            "agent.v2.session.follow_up",
            bind_async(s, core_methods::session_follow_up),
        ),
        (
            "agent.v2.session.approval.respond",
            bind_async(s, core_methods::session_approval_respond),
        ),
        (
            "agent.v2.session.abort",
            bind_async(s, core_methods::session_abort),
        ),
        (
            "agent.v2.session.get",
            bind_sync(s, core_methods::session_get),
        ),
        (
            "agent.v2.session.list",
            bind_sync(s, core_methods::session_list),
        ),
        (
            "agent.v2.session.replay",
            bind_sync(s, core_methods::session_replay),
        ),
        ("agent.v2.swarm.create", bind_sync(s, swarm::swarm_create)),
        ("agent.v2.swarm.list", bind_sync(s, swarm::swarm_list)),
        ("agent.v2.swarm.get", bind_sync(s, swarm::swarm_get)),
        ("agent.v2.swarm.update", bind_sync(s, swarm::swarm_update)),
        ("agent.v2.swarm.delete", bind_sync(s, swarm::swarm_delete)),
        ("agent.v2.swarm.fork", bind_sync(s, swarm::swarm_fork)),
        ("agent.v2.swarm.chain", bind_sync(s, swarm::swarm_chain)),
        ("agent.v2.swarm.deploy", bind_sync(s, swarm::swarm_deploy)),
        ("channels.list", bind_sync(s, core_methods::channels_list)),
        ("channels.pair", bind_async(s, core_methods::channels_pair)),
        (
            "channels.unpair",
            bind_async(s, core_methods::channels_unpair),
        ),
        ("inbox.list", bind_sync(s, inbox::inbox_list)),
        ("chat.send", bind_async(s, core_methods::chat_send)),
        ("chat.stream", bind_async(s, core_methods::chat_stream)),
        ("chat.abort", bind_sync(s, core_methods::chat_abort)),
        ("chat.history", bind_sync(s, core_methods::chat_history)),
        (
            "chat.conversations.list",
            bind_sync(s, core_methods::chat_conversations_list),
        ),
        (
            "chat.approval.respond",
            bind_async(s, core_methods::chat_approval_respond),
        ),
        (
            "sessions.delete",
            bind_sync(s, core_methods::sessions_delete),
        ),
        ("sessions.reset", bind_sync(s, core_methods::sessions_reset)),
        ("sessions.patch", bind_sync(s, core_methods::sessions_patch)),
    ]
}

/// Wraps an async handler so that it receives the shared services.
fn bind_async(
    services: &Arc<WsServices>,
    op: fn(Arc<WsServices>, WsCall) -> WsFuture,
) -> WsHandler {
    let services = Arc::clone(services);
    Arc::new(move |call: WsCall| op(Arc::clone(&services), call))
}

/// Wraps a synchronous handler. Its result is returned as an already-finished future.
fn bind_sync(
    services: &Arc<WsServices>,
    op: fn(&WsServices, &WsCall) -> Result<Value, HandlerError>,
) -> WsHandler {
    let services = Arc::clone(services);
    Arc::new(move |call: WsCall| -> WsFuture {
        let outcome = WsOutcome::from(op(&services, &call));
        Box::pin(async move { outcome })
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::test_support::fixture;
    use super::*;

    #[test]
    fn method_table_serves_exactly_the_pending_methods() {
        let (_fake, services) = fixture();
        let mut names: Vec<&str> = method_table(services)
            .into_iter()
            .map(|(name, _)| name)
            .collect();
        names.sort_unstable();

        let mut pending: Vec<&str> = crate::gateway_methods::pending_methods().to_vec();
        pending.sort_unstable();

        assert_eq!(names, pending);
        assert_eq!(names.len(), 30);
    }

    #[test]
    fn streamed_outcome_writes_no_response_frame() {
        assert_eq!(WsOutcome::Streamed.into_frame(&FrameId::number(1)), None);
    }

    #[test]
    fn payload_and_failure_outcomes_become_res_frames() {
        let id = FrameId::number(2);
        let ok = WsOutcome::Payload(json!({"a": 1})).into_frame(&id).unwrap();
        assert_eq!(ok["ok"], true);
        assert_eq!(ok["payload"]["a"], 1);

        let failed = WsOutcome::Failed(HandlerError::invalid("bad"))
            .into_frame(&id)
            .unwrap();
        assert_eq!(failed["ok"], false);
        assert_eq!(failed["error"]["code"], "INVALID_REQUEST");
        assert_eq!(failed["error"]["message"], "bad");
    }
}
