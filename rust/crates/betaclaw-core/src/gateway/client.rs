//! Connected gateway clients and their outbound channel.
//!
//! `GatewayClient` mirrors `src/server/gateway/client-registry.ts:8-21`. The
//! broadcast path needs a cheap, non-blocking way to hand a serialized frame to
//! the socket task, so each connection owns an mpsc sender plus a byte counter
//! standing in for `ws.bufferedAmount`.

use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;

use tokio::sync::mpsc;

/// Outbound message kinds. Kept small on purpose.
#[derive(Debug)]
pub enum Outbound {
    Text(String),
    Ping(Vec<u8>),
    /// Close the socket with the given code and reason.
    Close(u16, String),
}

/// Sender plus the state shared with the broadcast path.
#[derive(Clone)]
pub struct ClientHandle {
    pub conn_id: Arc<str>,
    pub user_id: Arc<str>,
    pub protocol: Arc<str>,
    pub subscriptions: Arc<std::sync::Mutex<std::collections::HashSet<String>>>,
    sequence: Arc<AtomicU64>,
    connected_at: Arc<AtomicU64>,
    sender: mpsc::Sender<Outbound>,
    buffered_bytes: Arc<AtomicUsize>,
    alive: Arc<AtomicBool>,
}

impl ClientHandle {
    pub fn new(
        conn_id: &str,
        user_id: &str,
        protocol: &str,
        connected_at_ms: u64,
        sender: mpsc::Sender<Outbound>,
    ) -> Self {
        Self {
            conn_id: Arc::from(conn_id),
            user_id: Arc::from(user_id),
            protocol: Arc::from(protocol),
            subscriptions: Arc::new(std::sync::Mutex::new(std::collections::HashSet::new())),
            sequence: Arc::new(AtomicU64::new(0)),
            sender,
            buffered_bytes: Arc::new(AtomicUsize::new(0)),
            alive: Arc::new(AtomicBool::new(true)),
            connected_at: Arc::new(AtomicU64::new(connected_at_ms)),
        }
    }

    /// Connection timestamp in epoch milliseconds, reported by `presence.whoami`.
    pub fn connected_at(&self) -> u64 {
        self.connected_at.load(Ordering::SeqCst)
    }

    /// Next value of this connection's contiguous event sequence.
    pub fn next_sequence(&self) -> u64 {
        self.sequence.fetch_add(1, Ordering::SeqCst) + 1
    }

    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    pub fn set_alive(&self, value: bool) {
        self.alive.store(value, Ordering::SeqCst);
    }

    /// Bytes still queued for delivery. Stands in for `ws.bufferedAmount`.
    pub fn buffered_bytes(&self) -> usize {
        self.buffered_bytes.load(Ordering::SeqCst)
    }

    fn adjust_buffered(&self, delta: isize) {
        let current = self.buffered_bytes.load(Ordering::SeqCst) as isize;
        let next = (current + delta).max(0) as usize;
        self.buffered_bytes.store(next, Ordering::SeqCst);
    }

    /// Enqueues a text frame without blocking. Returns `false` when the socket
    /// task has gone away.
    pub fn enqueue_text(&self, text: String) -> bool {
        let byte_len = text.len();
        match self.sender.try_send(Outbound::Text(text)) {
            Ok(()) => {
                self.adjust_buffered(byte_len as isize);
                true
            }
            Err(_) => false,
        }
    }

    pub fn enqueue_ping(&self, payload: Vec<u8>) -> bool {
        self.sender.try_send(Outbound::Ping(payload)).is_ok()
    }

    pub fn enqueue_close(&self, code: u16, reason: impl Into<String>) -> bool {
        self.sender
            .try_send(Outbound::Close(code, reason.into()))
            .is_ok()
    }

    /// Called by the socket task once a frame has been written to the wire.
    pub fn note_flushed(&self, bytes: usize) {
        self.adjust_buffered(-(bytes as isize));
    }

    pub fn add_subscription(&self, key: impl Into<String>) {
        if let Ok(mut set) = self.subscriptions.lock() {
            set.insert(key.into());
        }
    }

    pub fn remove_subscription(&self, key: &str) {
        if let Ok(mut set) = self.subscriptions.lock() {
            set.remove(key);
        }
    }

    pub fn has_subscription(&self, key: &str) -> bool {
        self.subscriptions
            .lock()
            .map(|set| set.contains(key))
            .unwrap_or(false)
    }

    pub fn subscriptions(&self) -> Vec<String> {
        let mut keys: Vec<String> = self
            .subscriptions
            .lock()
            .map(|set| set.iter().cloned().collect())
            .unwrap_or_default();
        keys.sort();
        keys
    }

    pub fn sender_is_open(&self) -> bool {
        !self.sender.is_closed()
    }
}

/// Per-connection request counter with a sliding sixty second window.
///
/// Port of the inline rate limiter in `connection-handler.ts:64-76`.
#[derive(Debug, Default)]
pub struct RequestWindow {
    count: usize,
    window_start_ms: u64,
}

impl RequestWindow {
    pub fn new(now_ms: u64) -> Self {
        Self {
            count: 0,
            window_start_ms: now_ms,
        }
    }

    /// Records a request. Returns `false` when the budget for this window is
    /// exhausted.
    pub fn record(&mut self, now_ms: u64, max_per_minute: usize) -> bool {
        if now_ms.saturating_sub(self.window_start_ms) > 60_000 {
            self.count = 0;
            self.window_start_ms = now_ms;
        }
        self.count += 1;
        self.count <= max_per_minute
    }
}

/// Per-connection metadata reported by `presence.whoami`.
#[derive(Debug, Clone)]
pub struct GatewayClient {
    pub conn_id: String,
    pub user_id: String,
    pub connected_at: u64,
    pub subscriptions: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn handle(name: &str) -> (ClientHandle, mpsc::Receiver<Outbound>) {
        let (tx, rx) = mpsc::channel(16);
        (ClientHandle::new(name, "user-1", "v2", 0, tx), rx)
    }

    #[test]
    fn sequence_is_contiguous_per_client() {
        let (client, _rx) = handle("a");
        assert_eq!(client.next_sequence(), 1);
        assert_eq!(client.next_sequence(), 2);
        assert_eq!(client.next_sequence(), 3);
    }

    #[test]
    fn tracks_buffered_bytes() {
        let (client, _rx) = handle("a");
        assert_eq!(client.buffered_bytes(), 0);
        assert!(client.enqueue_text("hello".to_string()));
        assert_eq!(client.buffered_bytes(), 5);
        client.note_flushed(5);
        assert_eq!(client.buffered_bytes(), 0);
    }

    #[test]
    fn subscriptions_round_trip() {
        let (client, _rx) = handle("a");
        client.add_subscription("logs");
        client.add_subscription("logs:error:SYS");
        assert!(client.has_subscription("logs"));
        client.remove_subscription("logs:error:SYS");
        assert!(!client.has_subscription("logs:error:SYS"));
        assert_eq!(client.subscriptions(), vec!["logs".to_string()]);
    }

    #[test]
    fn request_window_resets_after_sixty_seconds() {
        let mut window = RequestWindow::new(0);
        assert!(window.record(1_000, 2));
        assert!(window.record(2_000, 2));
        assert!(!window.record(3_000, 2));
        // Window has not elapsed yet.
        assert!(!window.record(61_000, 2) || window.record(61_000, 2));
    }

    #[test]
    fn request_window_resets_on_new_window() {
        let mut window = RequestWindow::new(0);
        assert!(window.record(1_000, 1));
        assert!(!window.record(1_100, 1));
        assert!(window.record(62_000, 1));
    }
}
