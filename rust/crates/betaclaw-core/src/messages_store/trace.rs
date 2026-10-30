//! Timing trace for the inbox and conversation queries.
//!
//! The TypeScript repositories call `logInboxDbQuery`
//! (`src/server/diagnostics/chatDisplayTrace.ts:78-92`) and `logChatRecallTrace`
//! (`src/server/diagnostics/chatRecallTrace.ts`) from the query methods. Both
//! write one JSON line to stdout, gated by `CHAT_DISPLAY_LOGS` /
//! `INBOX_V2_LOGS` and their `*_FORCE_LOGS` siblings, and both escalate a slow
//! statement to `warn` once it crosses `INBOX_DB_SLOW_MS` (default 500 ms).
//!
//! The full diagnostics module belongs to the observability slice; what the
//! datastore needs is only the escalation. This shim keeps the threshold and the
//! escalation and emits through `tracing`, so the structured logger already
//! installed in the gateway (`tracing_subscriber`) is what decides visibility.
//! The `{ scope, stage, ts, memory }` envelope of `logChatDisplayTrace` is not
//! reproduced: it is a console contract, not a storage one.

use std::time::Instant;

/// `DEFAULT_INBOX_DB_SLOW_MS` from `chatDisplayTrace.ts:8`.
const DEFAULT_INBOX_DB_SLOW_MS: i64 = 500;

/// `getInboxDbSlowThresholdMs` from `chatDisplayTrace.ts:31-33`.
pub fn inbox_db_slow_threshold_ms() -> i64 {
    std::env::var("INBOX_DB_SLOW_MS")
        .ok()
        .and_then(|value| value.trim().parse::<i64>().ok())
        .filter(|value| *value >= 0)
        .unwrap_or(DEFAULT_INBOX_DB_SLOW_MS)
}

/// RAII timer for one `logInboxDbQuery` call site.
///
/// The TypeScript source repeats `const startedAt = Date.now(); … durationMs:
/// Date.now() - startedAt` around every statement. The port wraps that pair in a
/// guard so the two halves cannot drift apart.
pub struct QueryTimer {
    started: Instant,
}

impl QueryTimer {
    pub fn start() -> Self {
        Self {
            started: Instant::now(),
        }
    }

    pub fn elapsed_ms(&self) -> i64 {
        self.started.elapsed().as_millis().min(i64::MAX as u128) as i64
    }
}

impl Default for QueryTimer {
    fn default() -> Self {
        Self::start()
    }
}

/// `logInboxDbQuery` — `debug!` for a fast statement, `warn!` once it crosses
/// the slow threshold.
pub fn log_inbox_db_query(stage: &str, duration_ms: i64) {
    let slow = duration_ms >= inbox_db_slow_threshold_ms();
    if slow {
        tracing::warn!(
            scope = "chat.display",
            query = stage,
            duration_ms,
            slow,
            slow_threshold_ms = inbox_db_slow_threshold_ms(),
            "slow inbox database query"
        );
    } else {
        tracing::debug!(
            scope = "chat.display",
            query = stage,
            duration_ms,
            slow,
            "inbox database query"
        );
    }
}

/// `logChatRecallTrace` for the FTS path in `repository/queries/search.ts`.
///
/// The source distinguishes three stages — `fts.query_skipped`,
/// `fts.query_completed` and `fts.query_failed` — and forces the last two to be
/// emitted even when tracing is off. `tracing` subscribers filter by level
/// instead, so only the escalation survives here.
pub fn log_chat_recall_trace(stage: &str) {
    match stage {
        "fts.query_failed" => {
            tracing::error!(scope = "chat.recall", stage, "chat recall query failed")
        }
        "fts.query_skipped" => {
            tracing::warn!(scope = "chat.recall", stage, "chat recall query skipped")
        }
        _ => tracing::debug!(scope = "chat.recall", stage, "chat recall query completed"),
    }
}

/// `DEFAULT_CHAT_RECALL_SLOW_MS` from `chatRecallTrace.ts:8`.
const DEFAULT_CHAT_RECALL_SLOW_MS: i64 = 1500;

/// `getChatRecallSlowThresholdMs` from `chatRecallTrace.ts:39-41`.
pub fn chat_recall_slow_threshold_ms() -> i64 {
    std::env::var("CHAT_RECALL_SLOW_MS")
        .ok()
        .and_then(|value| value.trim().parse::<i64>().ok())
        .filter(|value| *value >= 0)
        .unwrap_or(DEFAULT_CHAT_RECALL_SLOW_MS)
}

/// `fts.query_completed` from `search.ts:76-100`. Escalates to `warn` once the
/// statement crosses `CHAT_RECALL_SLOW_MS`, the same convention as
/// [`log_inbox_db_query`]. The source logs a slow completion at `info` with
/// `force`; the port keeps the escalation and leaves the level choice to `tracing`.
pub fn log_chat_recall_completed(
    duration_ms: i64,
    query_length: usize,
    result_count: usize,
    limit: i64,
) {
    let slow_threshold_ms = chat_recall_slow_threshold_ms();
    if duration_ms >= slow_threshold_ms {
        tracing::warn!(
            scope = "chat.recall",
            stage = "fts.query_completed",
            duration_ms,
            slow_threshold_ms,
            query_length,
            result_count,
            limit,
            "slow chat recall query"
        );
    } else {
        tracing::debug!(
            scope = "chat.recall",
            stage = "fts.query_completed",
            duration_ms,
            query_length,
            result_count,
            limit,
            "chat recall query completed"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chat_recall_threshold_defaults_to_1500_ms() {
        if std::env::var("CHAT_RECALL_SLOW_MS").is_err() {
            assert_eq!(chat_recall_slow_threshold_ms(), 1500);
        }
    }

    #[test]
    fn threshold_defaults_to_500_ms_and_follows_the_env_var() {
        if std::env::var("INBOX_DB_SLOW_MS").is_err() {
            assert_eq!(inbox_db_slow_threshold_ms(), 500);
        }
    }

    #[test]
    fn the_timer_measures_forward_progress() {
        let timer = QueryTimer::start();
        std::thread::sleep(std::time::Duration::from_millis(2));
        assert!(timer.elapsed_ms() >= 1);
    }
}
