//! The SSE broadcaster, port of `src/lib/events.ts`, behind
//! `app/api/events/stream/route.ts`.
//!
//! BetaClaw runs single-node, so the registry lives in this process, as in the
//! TypeScript. A subscriber's filter decides for each event whether that
//! subscriber receives it. The wire format matches the TypeScript byte for byte:
//! `: connected`, one `sse_connected` data frame with the diagnostics, then
//! `data: <json>` per event and `: keep-alive` on the interval.

use std::convert::Infallible;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use axum::body::Bytes;
use betaclaw_core::stats::util::now_iso;
use futures_util::Stream;
use serde::Serialize;
use serde_json::{json, Value};
use tokio::sync::mpsc;

/// `SSE_MODE` of `src/lib/events.ts`.
const SSE_MODE: &str = "single-node-in-memory";
const CONNECTED_FRAME: &[u8] = b": connected\n\n";
const KEEP_ALIVE_FRAME: &[u8] = b": keep-alive\n\n";

/// `SSEEvent` on the wire: `{"type": ..., "payload": ...}`, in this key order.
#[derive(Debug, Clone, Serialize)]
pub struct SseEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    pub payload: Value,
}

/// Decides whether one subscriber receives one event. It runs under the hub lock
/// during [`EventHub::broadcast`], so it must not call back into the hub.
pub type EventFilter = Box<dyn Fn(&SseEvent) -> bool + Send>;

struct Client {
    id: u64,
    frames: mpsc::UnboundedSender<Bytes>,
    filter: Option<EventFilter>,
}

#[derive(Default)]
struct HubState {
    /// Insertion order, so the oldest subscriber is the first entry.
    clients: Vec<Client>,
    next_id: u64,
    total_connections: u64,
    dropped_connections: u64,
    broadcasts_total: u64,
    last_broadcast_at: Option<String>,
    last_event_type: Option<String>,
}

/// The process-wide registry of SSE subscribers.
pub struct EventHub {
    max_clients: usize,
    keep_alive: Duration,
    state: Mutex<HubState>,
}

impl EventHub {
    pub fn new(max_clients: usize, keep_alive: Duration) -> Arc<Self> {
        Arc::new(Self {
            max_clients: max_clients.max(1),
            // `tokio::time::interval` panics on a zero period.
            keep_alive: keep_alive.max(Duration::from_millis(1)),
            state: Mutex::new(HubState::default()),
        })
    }

    /// The interval of the keep-alive comment on each stream.
    pub fn keep_alive(&self) -> Duration {
        self.keep_alive
    }

    /// `broadcast(event)`: sends the event to every subscriber whose filter admits it.
    pub fn broadcast(&self, event: &SseEvent) {
        let frame = Bytes::from(format!(
            "data: {}\n\n",
            serde_json::to_string(event).unwrap_or_default()
        ));
        let mut state = self.lock();
        state.broadcasts_total += 1;
        state.last_broadcast_at = Some(now_iso());
        state.last_event_type = Some(event.event_type.clone());
        state.clients.retain(|client| {
            if client.filter.as_ref().is_some_and(|filter| !filter(event)) {
                return true;
            }
            // A closed stream is removed, as the TypeScript does on a failed enqueue.
            client.frames.send(frame.clone()).is_ok()
        });
    }

    /// `registerClient`: adds a subscriber, closing the oldest one at capacity, and
    /// queues the two connect frames. The hub lock is held throughout, so no
    /// broadcast lands between the connect frames and the subscriber.
    pub fn subscribe(self: Arc<Self>, filter: Option<EventFilter>) -> Subscription {
        let (frames, receiver) = mpsc::unbounded_channel();
        let mut state = self.lock();
        state.total_connections += 1;
        if state.clients.len() >= self.max_clients {
            // Dropping the oldest sender ends its stream, as `pruneOldestClient` closes it.
            state.clients.remove(0);
            state.dropped_connections += 1;
        }
        let id = state.next_id;
        state.next_id += 1;
        state.clients.push(Client {
            id,
            frames: frames.clone(),
            filter,
        });
        let _ = frames.send(Bytes::from_static(CONNECTED_FRAME));
        let connected = json!({ "type": "sse_connected", "payload": self.diagnostics_of(&state) });
        let _ = frames.send(Bytes::from(format!("data: {connected}\n\n")));
        drop(state);
        Subscription {
            id,
            frames: receiver,
            hub: self,
        }
    }

    /// `getSseDiagnostics()`.
    pub fn diagnostics(&self) -> Value {
        self.diagnostics_of(&self.lock())
    }

    fn diagnostics_of(&self, state: &HubState) -> Value {
        json!({
            "mode": SSE_MODE,
            "maxClients": self.max_clients,
            "connectedClients": state.clients.len(),
            "totalConnections": state.total_connections,
            "droppedConnections": state.dropped_connections,
            "broadcastsTotal": state.broadcasts_total,
            "lastBroadcastAt": state.last_broadcast_at,
            "lastEventType": state.last_event_type,
        })
    }

    fn unregister(&self, id: u64) {
        self.lock().clients.retain(|client| client.id != id);
    }

    fn lock(&self) -> MutexGuard<'_, HubState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// One registered subscriber. Dropping it unregisters the subscriber, as the
/// TypeScript's abort handler does.
pub struct Subscription {
    id: u64,
    frames: mpsc::UnboundedReceiver<Bytes>,
    hub: Arc<EventHub>,
}

impl Subscription {
    /// The next frame, or `None` once the hub has closed this subscriber.
    pub async fn next_frame(&mut self) -> Option<Bytes> {
        self.frames.recv().await
    }
}

impl Drop for Subscription {
    fn drop(&mut self) {
        self.hub.unregister(self.id);
    }
}

/// The body of `GET /api/events/stream`: the queued frames, interleaved with a
/// keep-alive comment every `keep_alive`. The stream ends when the hub closes it.
pub fn frame_stream(
    subscription: Subscription,
    keep_alive: Duration,
) -> impl Stream<Item = Result<Bytes, Infallible>> + Send {
    let ticker = tokio::time::interval_at(tokio::time::Instant::now() + keep_alive, keep_alive);
    futures_util::stream::unfold(
        (subscription, ticker),
        |(mut subscription, mut ticker)| async move {
            let frame = tokio::select! {
                frame = subscription.next_frame() => frame,
                _ = ticker.tick() => Some(Bytes::from_static(KEEP_ALIVE_FRAME)),
            };
            frame.map(|bytes| (Ok::<Bytes, Infallible>(bytes), (subscription, ticker)))
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(kind: &str) -> SseEvent {
        SseEvent {
            event_type: kind.to_string(),
            payload: json!({ "n": 1 }),
        }
    }

    async fn next_text(subscription: &mut Subscription) -> String {
        let frame = tokio::time::timeout(Duration::from_secs(2), subscription.next_frame())
            .await
            .expect("frame within 2s")
            .expect("stream still open");
        String::from_utf8(frame.to_vec()).expect("utf-8 frame")
    }

    #[tokio::test]
    async fn connect_frames_and_events_use_the_typescript_wire_format() {
        let hub = EventHub::new(20, Duration::from_secs(30));
        let mut subscription = Arc::clone(&hub).subscribe(None);

        assert_eq!(next_text(&mut subscription).await, ": connected\n\n");
        let connected = next_text(&mut subscription).await;
        assert_eq!(
            connected,
            format!(
                "data: {}\n\n",
                json!({
                    "type": "sse_connected",
                    "payload": {
                        "mode": "single-node-in-memory",
                        "maxClients": 20,
                        "connectedClients": 1,
                        "totalConnections": 1,
                        "droppedConnections": 0,
                        "broadcastsTotal": 0,
                        "lastBroadcastAt": null,
                        "lastEventType": null,
                    }
                })
            )
        );

        hub.broadcast(&event("task_updated"));
        assert_eq!(
            next_text(&mut subscription).await,
            "data: {\"type\":\"task_updated\",\"payload\":{\"n\":1}}\n\n"
        );
        assert_eq!(hub.diagnostics()["broadcastsTotal"], 1);
        assert_eq!(hub.diagnostics()["lastEventType"], "task_updated");
    }

    #[tokio::test]
    async fn the_filter_decides_per_subscriber() {
        let hub = EventHub::new(20, Duration::from_secs(30));
        let mut hidden = Arc::clone(&hub).subscribe(Some(Box::new(|_: &SseEvent| false)));
        let mut visible = Arc::clone(&hub).subscribe(None);
        for _ in 0..2 {
            next_text(&mut hidden).await;
            next_text(&mut visible).await;
        }

        hub.broadcast(&event("only_visible"));

        assert!(next_text(&mut visible).await.contains("only_visible"));
        let hidden_result =
            tokio::time::timeout(Duration::from_millis(50), hidden.next_frame()).await;
        assert!(
            hidden_result.is_err(),
            "the filtered subscriber gets nothing"
        );
    }

    #[tokio::test]
    async fn the_oldest_subscriber_is_closed_at_capacity() {
        let hub = EventHub::new(1, Duration::from_secs(30));
        let mut first = Arc::clone(&hub).subscribe(None);
        let _second = Arc::clone(&hub).subscribe(None);

        assert_eq!(hub.diagnostics()["droppedConnections"], 1);
        assert_eq!(hub.diagnostics()["connectedClients"], 1);
        // The buffered connect frames drain first, then the stream ends.
        next_text(&mut first).await;
        next_text(&mut first).await;
        let end = tokio::time::timeout(Duration::from_secs(2), first.next_frame())
            .await
            .expect("closed promptly");
        assert!(end.is_none());
    }

    #[tokio::test]
    async fn keep_alive_comment_is_sent_on_the_interval() {
        let hub = EventHub::new(20, Duration::from_millis(15));
        let subscription = Arc::clone(&hub).subscribe(None);
        let mut stream = Box::pin(frame_stream(subscription, hub.keep_alive()));

        // Two connect frames, then the first keep-alive, which has no event behind it.
        let mut seen = Vec::new();
        for _ in 0..3 {
            let frame = tokio::time::timeout(
                Duration::from_secs(2),
                futures_util::StreamExt::next(&mut stream),
            )
            .await
            .expect("frame within 2s")
            .expect("stream open")
            .expect("infallible");
            seen.push(String::from_utf8(frame.to_vec()).expect("utf-8"));
        }
        assert_eq!(seen[0], ": connected\n\n");
        assert!(seen[1].starts_with("data: {\"type\":\"sse_connected\""));
        assert_eq!(seen[2], ": keep-alive\n\n");
    }

    #[tokio::test]
    async fn dropping_a_subscription_unregisters_it() {
        let hub = EventHub::new(20, Duration::from_secs(30));
        let subscription = Arc::clone(&hub).subscribe(None);
        assert_eq!(hub.diagnostics()["connectedClients"], 1);

        drop(subscription);

        assert_eq!(hub.diagnostics()["connectedClients"], 0);
        assert_eq!(hub.diagnostics()["totalConnections"], 1);
    }
}
