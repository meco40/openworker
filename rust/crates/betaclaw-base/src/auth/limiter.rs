//! Login rate limiter.
//!
//! Port of `src/server/auth/loginRateLimiter.ts`. The limiter is per process and
//! in-memory by design; the TypeScript file documents the same limitation.

use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

const DEFAULT_MAX_FAILURES: u32 = 10;
const DEFAULT_WINDOW_MS: u64 = 15 * 60 * 1000;
const DEFAULT_MAX_ENTRIES: usize = 10_000;
const MAX_IP_LENGTH: usize = 64;

#[derive(Debug, Clone)]
struct Entry {
    count: u32,
    window_start_ms: u64,
}

#[derive(Debug, Clone)]
pub struct LoginRateLimiter {
    entries: HashMap<String, Entry>,
    /// Insertion order, so eviction drops the oldest key like `Map` does.
    order: Vec<String>,
    max_failures: u32,
    window_ms: u64,
    max_entries: usize,
    last_prune_ms: u64,
}

impl Default for LoginRateLimiter {
    fn default() -> Self {
        Self::new(DEFAULT_MAX_FAILURES, DEFAULT_WINDOW_MS, DEFAULT_MAX_ENTRIES)
    }
}

impl LoginRateLimiter {
    pub fn new(max_failures: u32, window_ms: u64, max_entries: usize) -> Self {
        Self {
            entries: HashMap::new(),
            order: Vec::new(),
            max_failures,
            window_ms,
            max_entries,
            last_prune_ms: now_ms(),
        }
    }

    pub fn is_blocked(&mut self, key: &str) -> bool {
        match self.active_entry(key) {
            Some(entry) => entry.count >= self.max_failures,
            None => false,
        }
    }

    pub fn record_failure(&mut self, key: &str) {
        let now = now_ms();
        self.prune_if_due(now);

        if let Some(entry) = self.entries.get_mut(key) {
            entry.count += 1;
            return;
        }

        if self.order.len() >= self.max_entries {
            if let Some(oldest) = self.order.first().cloned() {
                self.order.remove(0);
                self.entries.remove(&oldest);
            }
        }
        self.order.push(key.to_string());
        self.entries.insert(
            key.to_string(),
            Entry {
                count: 1,
                window_start_ms: now,
            },
        );
    }

    pub fn reset(&mut self, key: &str) {
        if self.entries.remove(key).is_some() {
            self.order.retain(|entry| entry != key);
        }
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    fn active_entry(&mut self, key: &str) -> Option<&Entry> {
        let now = now_ms();
        let expired = match self.entries.get(key) {
            Some(entry) => now.saturating_sub(entry.window_start_ms) >= self.window_ms,
            None => return None,
        };
        if expired {
            self.remove(key);
            return None;
        }
        self.entries.get(key)
    }

    fn remove(&mut self, key: &str) {
        self.entries.remove(key);
        self.order.retain(|entry| entry != key);
    }

    fn prune_if_due(&mut self, now: u64) {
        if now.saturating_sub(self.last_prune_ms) < self.window_ms {
            return;
        }
        self.last_prune_ms = now;
        let window = self.window_ms;
        self.entries
            .retain(|_, entry| now.saturating_sub(entry.window_start_ms) < window);
        self.order.retain(|key| self.entries.contains_key(key));
    }
}

/// Best-effort client IP from the first hop of `X-Forwarded-For`.
///
/// The header is client-controlled unless a trusted proxy sets it, so it is only
/// ever used as a secondary rate-limit key, matching the TypeScript comment.
pub fn resolve_client_ip(forwarded_for: Option<&str>) -> Option<String> {
    let raw = forwarded_for?;
    let first = raw.split(',').next()?.trim();
    let trimmed: String = first.chars().take(MAX_IP_LENGTH).collect();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_after_max_failures() {
        let mut limiter = LoginRateLimiter::new(3, 60_000, 100);
        assert!(!limiter.is_blocked("email:a@b.c"));
        limiter.record_failure("email:a@b.c");
        limiter.record_failure("email:a@b.c");
        assert!(!limiter.is_blocked("email:a@b.c"));
        limiter.record_failure("email:a@b.c");
        assert!(limiter.is_blocked("email:a@b.c"));
    }

    #[test]
    fn keys_are_independent() {
        let mut limiter = LoginRateLimiter::new(1, 60_000, 100);
        limiter.record_failure("email:a@b.c");
        assert!(limiter.is_blocked("email:a@b.c"));
        assert!(!limiter.is_blocked("email:other@b.c"));
        assert!(!limiter.is_blocked("ip:127.0.0.1"));
    }

    #[test]
    fn reset_clears_a_blocked_key() {
        let mut limiter = LoginRateLimiter::new(1, 60_000, 100);
        limiter.record_failure("k");
        assert!(limiter.is_blocked("k"));
        limiter.reset("k");
        assert!(!limiter.is_blocked("k"));
        assert_eq!(limiter.len(), 0);
    }

    #[test]
    fn evicts_oldest_entry_when_full() {
        // Eviction is FIFO, mirroring the JavaScript `Map` iteration order in
        // `recordFailure`: the first inserted key is dropped once the map is
        // full, and re-inserting a key moves it to the back of the queue.
        let mut limiter = LoginRateLimiter::new(3, 60_000, 2);
        limiter.record_failure("a");
        limiter.record_failure("b");
        assert_eq!(limiter.len(), 2);

        // Full: inserting "c" evicts "a".
        limiter.record_failure("c");
        assert_eq!(limiter.len(), 2, "the map must stay bounded");
        assert!(!limiter.is_blocked("a"), "a was evicted");

        // Re-inserting "a" is itself an insert, so it evicts "b" and "a" ends
        // up at the back of the queue.
        limiter.record_failure("a");
        assert_eq!(limiter.len(), 2);
        assert!(!limiter.is_blocked("b"), "b was evicted by the re-insert");

        // "c" survived the whole sequence with its original counter.
        limiter.record_failure("c");
        limiter.record_failure("c");
        assert!(limiter.is_blocked("c"));
    }

    #[test]
    fn eviction_is_bounded_under_load() {
        let mut limiter = LoginRateLimiter::new(1000, 60_000, 8);
        for index in 0..100 {
            limiter.record_failure(&format!("key-{index}"));
        }
        assert_eq!(limiter.len(), 8, "size must never exceed max_entries");
    }

    #[test]
    fn client_ip_takes_first_hop_and_truncates() {
        assert_eq!(
            resolve_client_ip(Some("203.0.113.7, 10.0.0.1")),
            Some("203.0.113.7".into())
        );
        assert_eq!(
            resolve_client_ip(Some("  203.0.113.7  ")),
            Some("203.0.113.7".into())
        );
        assert_eq!(resolve_client_ip(Some(",,")), None);
        assert_eq!(resolve_client_ip(None), None);
        let long = "x".repeat(200);
        assert_eq!(resolve_client_ip(Some(&long)).unwrap().len(), MAX_IP_LENGTH);
    }
}
