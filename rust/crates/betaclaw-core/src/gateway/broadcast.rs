//! Scoped event broadcast with slow-consumer handling.
//!
//! Port of `src/server/gateway/broadcast.ts`. Each target connection receives a
//! sequenced event frame so the browser gap detector never sees false positives
//! caused by a scoped broadcast.

use serde_json::Value;

use super::client::ClientHandle;
use super::protocol::make_event;
use super::registry::ClientRegistry;
use super::MAX_BUFFERED_BYTES;

fn send_event(client: &ClientHandle, event: &str, payload: Option<Value>) {
    // Slow-consumer detection, matching `sendRawToClient` in broadcast.ts.
    if client.buffered_bytes() > MAX_BUFFERED_BYTES {
        tracing::warn!(
            conn_id = %client.conn_id,
            buffered = client.buffered_bytes(),
            "Closing slow consumer"
        );
        client.enqueue_close(1008, "slow consumer");
        return;
    }

    let seq = client.next_sequence();
    let frame = make_event(event, payload, Some(seq));
    let serialized = match serde_json::to_string(&frame) {
        Ok(text) => text,
        Err(error) => {
            tracing::error!(conn_id = %client.conn_id, error = %error, "Failed to serialize event frame");
            client.enqueue_close(1011, "send error");
            return;
        }
    };

    if !client.enqueue_text(serialized) {
        tracing::debug!(conn_id = %client.conn_id, "Target socket is gone");
    }
}

/// Broadcasts to every connected client.
pub fn broadcast(registry: &ClientRegistry, event: &str, payload: Option<Value>) {
    for client in registry.get_all() {
        send_event(&client, event, payload.clone());
    }
}

/// Broadcasts to every connection of one user.
pub fn broadcast_to_user(
    registry: &ClientRegistry,
    user_id: &str,
    event: &str,
    payload: Option<Value>,
) {
    for client in registry.get_by_user_id(user_id) {
        send_event(&client, event, payload.clone());
    }
}

/// Broadcasts to clients subscribed to a subscription key.
pub fn broadcast_to_subscribed(
    registry: &ClientRegistry,
    key: &str,
    event: &str,
    payload: Option<Value>,
) {
    for client in registry.get_all() {
        if client.has_subscription(key) {
            send_event(&client, event, payload.clone());
        }
    }
}

/// Sends a pre-built event to specific connections.
pub fn broadcast_to_conn_ids(
    registry: &ClientRegistry,
    conn_ids: &[String],
    event: &str,
    payload: Option<Value>,
) {
    for conn_id in conn_ids {
        let Some(client) = registry.get(conn_id) else {
            continue;
        };
        send_event(&client, event, payload.clone());
    }
}

/// Runs one transport keepalive sweep.
///
/// Port of `runGatewayKeepaliveSweep()`: a client that missed the previous
/// round's pong is terminated, everyone else is pinged and marked as waiting.
pub fn run_keepalive_sweep(registry: &ClientRegistry) {
    for client in registry.get_all() {
        if !client.sender_is_open() {
            continue;
        }
        if !client.is_alive() {
            tracing::debug!(conn_id = %client.conn_id, "Terminating stale websocket client");
            client.enqueue_close(1001, "keepalive timeout");
            continue;
        }
        client.set_alive(false);
        client.enqueue_ping(Vec::new());
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::gateway::protocol::{parse_frame, GatewayFrame};
    use tokio::sync::mpsc;

    fn setup() -> (Arc<ClientRegistry>, Vec<mpsc::Receiver<Outbound>>) {
        let registry = Arc::new(ClientRegistry::new());
        let mut receivers = Vec::new();
        for index in 0..3 {
            let (tx, rx) = mpsc::channel(32);
            registry.register(ClientHandle::new(
                &format!("c{index}"),
                if index == 0 { "u1" } else { "u2" },
                "v2",
                0,
                tx,
            ));
            receivers.push(rx);
        }
        (registry, receivers)
    }

    use super::super::client::Outbound;

    fn drain_text(rx: &mut mpsc::Receiver<Outbound>) -> Vec<String> {
        let mut out = Vec::new();
        while let Ok(Outbound::Text(text)) = rx.try_recv() {
            out.push(text);
        }
        out
    }

    #[test]
    fn broadcast_sequences_per_connection() {
        let (registry, mut receivers) = setup();
        broadcast(&registry, "tick", Some(serde_json::json!({"ts": 1})));

        let first = drain_text(&mut receivers[0]);
        assert_eq!(first.len(), 1);
        match parse_frame(&first[0]).unwrap() {
            GatewayFrame::Event(event) => {
                assert_eq!(event.event, "tick");
                assert_eq!(event.seq, Some(1));
            }
            other => panic!("unexpected frame {other:?}"),
        }

        broadcast(&registry, "tick", Some(serde_json::json!({"ts": 2})));
        let first = drain_text(&mut receivers[0]);
        match parse_frame(&first[0]).unwrap() {
            GatewayFrame::Event(event) => assert_eq!(event.seq, Some(2)),
            other => panic!("unexpected frame {other:?}"),
        }
    }

    #[test]
    fn broadcast_to_user_is_scoped() {
        let (registry, mut receivers) = setup();
        broadcast_to_user(&registry, "u1", "presence.update", None);
        assert_eq!(drain_text(&mut receivers[0]).len(), 1);
        assert!(drain_text(&mut receivers[1]).is_empty());
        assert!(drain_text(&mut receivers[2]).is_empty());
    }

    #[test]
    fn broadcast_to_subscribed_respects_subscriptions() {
        let (registry, mut receivers) = setup();
        registry.get("c1").unwrap().add_subscription("logs");

        broadcast_to_subscribed(&registry, "logs", "log.entry", None);
        // Only c1 subscribed, so only c1 receives the frame.
        assert!(drain_text(&mut receivers[0]).is_empty());
        assert_eq!(drain_text(&mut receivers[1]).len(), 1);
        assert!(drain_text(&mut receivers[2]).is_empty());
    }

    #[test]
    fn broadcast_to_conn_ids_targets_exact_connections() {
        let (registry, mut receivers) = setup();
        broadcast_to_conn_ids(
            &registry,
            &["c0".to_string(), "missing".to_string()],
            "tick",
            None,
        );
        assert_eq!(drain_text(&mut receivers[0]).len(), 1);
        assert!(drain_text(&mut receivers[1]).is_empty());
    }

    #[test]
    fn slow_consumers_are_closed_with_1008() {
        let registry = ClientRegistry::new();
        let (tx, mut rx) = mpsc::channel(8);
        let client = ClientHandle::new("c0", "u1", "v2", 0, tx);
        registry.register(client.clone());

        // Fill past the backpressure threshold without draining the socket.
        let filler = "x".repeat(MAX_BUFFERED_BYTES + 1);
        assert!(client.enqueue_text(filler));
        assert!(client.buffered_bytes() > MAX_BUFFERED_BYTES);

        broadcast(&registry, "tick", None);
        let mut closed = false;
        while let Ok(message) = rx.try_recv() {
            if let Outbound::Close(code, reason) = message {
                assert_eq!(code, 1008);
                assert_eq!(reason, "slow consumer");
                closed = true;
            }
        }
        assert!(closed, "expected a 1008 close for a slow consumer");
    }

    #[test]
    fn consumers_at_the_threshold_still_receive() {
        // The check is strictly greater-than, so a client sitting exactly at the
        // limit must keep receiving frames.
        let registry = ClientRegistry::new();
        let (tx, mut rx) = mpsc::channel(8);
        let client = ClientHandle::new("c0", "u1", "v2", 0, tx);
        registry.register(client.clone());

        assert!(client.enqueue_text("x".repeat(MAX_BUFFERED_BYTES)));
        assert_eq!(client.buffered_bytes(), MAX_BUFFERED_BYTES);

        broadcast(&registry, "tick", None);
        // The filler is still queued, so two frames are pending in total.
        assert_eq!(drain_text(&mut rx).len(), 2);
    }

    #[test]
    fn keepalive_pings_then_terminates() {
        let registry = ClientRegistry::new();
        let (tx, mut rx) = mpsc::channel(8);
        registry.register(ClientHandle::new("c0", "u1", "v2", 0, tx));

        run_keepalive_sweep(&registry);
        assert!(matches!(rx.try_recv(), Ok(Outbound::Ping(_))));

        // No pong arrived, so the next sweep terminates the socket.
        run_keepalive_sweep(&registry);
        let mut terminated = false;
        while let Ok(message) = rx.try_recv() {
            if let Outbound::Close(_, _) = message {
                terminated = true;
            }
        }
        assert!(terminated);
    }

    #[test]
    fn keepalive_resets_after_pong() {
        let registry = ClientRegistry::new();
        let (tx, _rx) = mpsc::channel(8);
        registry.register(ClientHandle::new("c0", "u1", "v2", 0, tx));

        run_keepalive_sweep(&registry);
        registry.get("c0").unwrap().set_alive(true);
        run_keepalive_sweep(&registry);
        // Still alive because the pong was observed.
        assert!(!registry.get("c0").unwrap().is_alive());
    }
}
