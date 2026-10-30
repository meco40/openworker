//! Port of `app/api/master/events/route.ts` (GET, server-sent events) over
//! `src/server/master/liveEvents.ts`.
//!
//! The TypeScript route subscribes to the process-wide `getServerEventBus()` of
//! slice S13, which has no Rust port yet. [`MasterEventBus`] is this family's stream
//! source: every native master mutation publishes into it, and the SSE stream relays
//! those events. Each event is also broadcast to the user's WebSocket connections
//! through the gateway [`ClientRegistry`], which stands in for the process bus until
//! S13 lands. Mutations made by proxied routes reach neither.
//!
//! The scope is resolved before the stream opens. The TypeScript resolves it inside
//! the stream's `start`, where a failure would close the stream; here it is a `400`.

use std::convert::Infallible;
use std::sync::Arc;
use std::time::Duration;

use axum::body::{Body, Bytes};
use axum::extract::Extension;
use axum::http::{header, HeaderMap, StatusCode, Uri};
use axum::response::IntoResponse;
use betaclaw_core::gateway::broadcast::broadcast_to_user;
use betaclaw_core::gateway::registry::ClientRegistry;
use betaclaw_core::master::feature_flags::is_master_operator_events_enabled;
use betaclaw_core::master::live_events::{
    MasterEventPublisher, MasterUpdatedEvent, MASTER_UPDATED_EVENT,
};
use betaclaw_core::master::repository::now_iso;
use betaclaw_core::master::types::WorkspaceScope;
use chrono::Utc;
use serde_json::{json, Value};
use tokio::sync::broadcast::{self, error::RecvError};
use tokio::time::{interval_at, Instant, Interval};

use super::support::{query_of, user_or_401, ApiError, Reply};
use super::Services;

/// `setInterval(..., 30_000)` of the TypeScript heartbeat.
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(30);
/// Events buffered per slow subscriber before it skips ahead.
const CHANNEL_CAPACITY: usize = 256;

/// The family's `master.updated` bus. Publishing never blocks and never fails the
/// caller: with no subscriber the event is dropped, as the TypeScript publish is.
pub struct MasterEventBus {
    sender: broadcast::Sender<MasterUpdatedEvent>,
    /// The gateway client registry, when the integrator attaches one.
    process_bus: Option<Arc<ClientRegistry>>,
}

impl MasterEventBus {
    /// `process_bus` is the gateway client registry; `None` keeps the bus local.
    pub fn new(process_bus: Option<Arc<ClientRegistry>>) -> Self {
        let (sender, _) = broadcast::channel(CHANNEL_CAPACITY);
        Self {
            sender,
            process_bus,
        }
    }

    fn subscribe(&self) -> broadcast::Receiver<MasterUpdatedEvent> {
        self.sender.subscribe()
    }
}

impl MasterEventPublisher for MasterEventBus {
    fn publish_master_updated(&self, event: &MasterUpdatedEvent) {
        let _ = self.sender.send(event.clone());
        if let Some(registry) = &self.process_bus {
            let payload = serde_json::to_value(event).ok();
            broadcast_to_user(registry, &event.user_id, MASTER_UPDATED_EVENT, payload);
        }
    }
}

/// `GET /api/master/events` (`events/route.ts:14-117`).
pub(super) async fn stream(
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    uri: Uri,
) -> Reply {
    if !is_master_operator_events_enabled(&services.env) {
        return Err(ApiError::new(
            StatusCode::NOT_FOUND,
            "Master operator events are disabled.",
        ));
    }
    let user = user_or_401(&headers)?;
    let scope = {
        let repos = services.repos().await;
        repos.scope(&query_of(&uri), &user, None)?
    };
    // Subscribe before answering, so no event between the answer and the first read is lost.
    let live = Live {
        events: services.events.subscribe(),
        scope,
        ticker: interval_at(Instant::now() + HEARTBEAT_INTERVAL, HEARTBEAT_INTERVAL),
        connected: false,
    };
    let frames = futures_util::stream::unfold(live, next_frame);
    Ok((
        [
            (header::CACHE_CONTROL, "no-cache, no-transform"),
            (header::CONNECTION, "keep-alive"),
            (header::CONTENT_TYPE, "text/event-stream"),
        ],
        Body::from_stream(frames),
    )
        .into_response())
}

/// The state of one open stream.
struct Live {
    events: broadcast::Receiver<MasterUpdatedEvent>,
    scope: WorkspaceScope,
    ticker: Interval,
    connected: bool,
}

/// One wake-up of the stream loop.
enum Wake {
    Event(MasterUpdatedEvent),
    Tick,
    Skip,
    Closed,
}

async fn next_frame(mut live: Live) -> Option<(Result<Bytes, Infallible>, Live)> {
    if !live.connected {
        live.connected = true;
        let data = json!({ "id": now_millis(), "type": "connected", "at": now_iso() });
        return Some((Ok(frame("connected", &data)), live));
    }
    loop {
        let wake = tokio::select! {
            received = live.events.recv() => match received {
                Ok(event)
                    if event.user_id == live.scope.user_id
                        && event.workspace_id == live.scope.workspace_id =>
                {
                    Wake::Event(event)
                }
                Ok(_) | Err(RecvError::Lagged(_)) => Wake::Skip,
                Err(RecvError::Closed) => Wake::Closed,
            },
            _ = live.ticker.tick() => Wake::Tick,
        };
        match wake {
            Wake::Event(event) => {
                let data = json!({
                    "id": now_millis(),
                    "type": "updated",
                    "at": event.at,
                    "resources": event.resources,
                    "runId": event.run_id,
                    "approvalRequestId": event.approval_request_id,
                    "sessionId": event.session_id,
                    "reminderId": event.reminder_id,
                });
                return Some((Ok(frame("updated", &data)), live));
            }
            Wake::Tick => {
                let data = json!({ "id": now_millis(), "type": "heartbeat", "at": now_iso() });
                return Some((Ok(frame("heartbeat", &data)), live));
            }
            Wake::Skip => continue,
            Wake::Closed => return None,
        }
    }
}

/// One server-sent event: `id`, `event`, a 5 s retry and the JSON `data`.
fn frame(event: &str, data: &Value) -> Bytes {
    let id = data["id"].as_str().map_or_else(String::new, str::to_string);
    Bytes::from(format!(
        "id: {id}\nevent: {event}\nretry: 5000\ndata: {data}\n\n"
    ))
}

fn now_millis() -> String {
    Utc::now().timestamp_millis().to_string()
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use axum::body::BodyDataStream;
    use axum::http::{Method, StatusCode};
    use betaclaw_core::master::feature_flags::MasterEnv;
    use betaclaw_core::master::http::QueryParams;
    use betaclaw_core::master::live_events::{
        publish_master_updated, MasterInvalidationResource, PublishMasterUpdatedInput,
    };
    use betaclaw_core::master::types::WorkspaceScope;
    use futures_util::StreamExt;

    use crate::families::master::test_support::{Harness, OWNER, SCOPE};

    /// The next frame of the stream as text. Fails rather than hangs.
    async fn next_frame(stream: &mut BodyDataStream) -> String {
        let chunk = tokio::time::timeout(Duration::from_secs(5), stream.next())
            .await
            .expect("a frame within 5 seconds")
            .expect("stream still open")
            .expect("frame bytes");
        String::from_utf8(chunk.to_vec()).expect("utf-8 frame")
    }

    #[tokio::test]
    async fn stream_opens_with_connected_and_relays_the_scope_updates() {
        let harness = Harness::new();
        let response = harness
            .raw(
                Method::GET,
                &format!("/api/master/events{SCOPE}"),
                Some(OWNER),
                None,
            )
            .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["content-type"], "text/event-stream");
        let mut stream = response.into_body().into_data_stream();

        let connected = next_frame(&mut stream).await;
        assert!(connected.contains("event: connected"), "{connected}");

        // The stream filters on the workspace the scope resolves to, which is not the raw query value.
        let scope = {
            let repos = harness.services.repos().await;
            repos
                .scope(&QueryParams::parse("workspaceId=main"), OWNER, None)
                .expect("scope resolves")
        };
        publish_master_updated(
            &harness.services.events,
            &PublishMasterUpdatedInput {
                scope,
                resources: vec![MasterInvalidationResource::Runs],
                run_id: Some("run-1".to_string()),
                approval_request_id: None,
                session_id: None,
                reminder_id: None,
            },
        );
        let updated = next_frame(&mut stream).await;
        assert!(updated.contains("event: updated"), "{updated}");
        assert!(updated.contains(r#""runId":"run-1""#), "{updated}");
    }

    #[test]
    fn an_event_reaches_the_users_websocket_connections_only() {
        use std::sync::Arc;

        use betaclaw_core::gateway::client::{ClientHandle, Outbound};
        use betaclaw_core::gateway::registry::ClientRegistry;

        use super::MasterEventBus;

        let registry = Arc::new(ClientRegistry::new());
        let (own_tx, mut own_rx) = tokio::sync::mpsc::channel(8);
        let (other_tx, mut other_rx) = tokio::sync::mpsc::channel(8);
        registry.register(ClientHandle::new("c-own", "user-1", "v2", 0, own_tx));
        registry.register(ClientHandle::new("c-other", "user-2", "v2", 0, other_tx));
        let bus = MasterEventBus::new(Some(registry));

        publish_master_updated(
            &bus,
            &PublishMasterUpdatedInput {
                scope: WorkspaceScope {
                    user_id: "user-1".to_string(),
                    workspace_id: "main".to_string(),
                },
                resources: vec![MasterInvalidationResource::Runs],
                run_id: Some("run-9".to_string()),
                approval_request_id: None,
                session_id: None,
                reminder_id: None,
            },
        );

        let Ok(Outbound::Text(frame)) = own_rx.try_recv() else {
            panic!("the owner's connection receives the event");
        };
        assert!(frame.contains("master.updated"), "{frame}");
        assert!(frame.contains("run-9"), "{frame}");
        assert!(
            other_rx.try_recv().is_err(),
            "another user's connection gets nothing"
        );
    }

    #[tokio::test]
    async fn stream_is_gated_by_the_flag_and_the_identity() {
        let harness = Harness::new();
        let (status, body) = harness
            .send(
                Method::GET,
                &format!("/api/master/events{SCOPE}"),
                None,
                None,
            )
            .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(body["error"], "Unauthorized");

        let env = MasterEnv::from([(
            "MASTER_OPERATOR_EVENTS_ENABLED".to_string(),
            "0".to_string(),
        )]);
        let gated = Harness::with_env(env);
        let (status, body) = gated
            .send(
                Method::GET,
                &format!("/api/master/events{SCOPE}"),
                Some(OWNER),
                None,
            )
            .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["error"], "Master operator events are disabled.");
    }
}
