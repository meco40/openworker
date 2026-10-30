//! Helpers shared by the migrated channel routes.
//!
//! Conversations, messages, inbox and channel state answer with the same error
//! shapes and the same inbox events as their TypeScript originals, so the
//! helpers live in one place.

use std::sync::atomic::{AtomicU64, Ordering};

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use betaclaw_core::gateway::broadcast::broadcast_to_user;
use betaclaw_core::gateway::events::INBOX_UPDATED;
use betaclaw_core::messages_store::{now_iso, InboxItemRecord, MessageRepositoryError};
use serde_json::{json, Value};

use crate::state::AppState;

/// `{ ok: false, error }` with the given status, as the TypeScript routes return it.
pub(crate) fn error_response(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({ "ok": false, "error": message }))).into_response()
}

/// A repository failure. The TypeScript catch blocks answer 500 with the message.
pub(crate) fn failure(error: &MessageRepositoryError) -> Response {
    error_response(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string())
}

/// `parseInt(raw, 10)` for the query values the channel routes read: optional
/// leading whitespace, optional sign, then digits. Trailing text is ignored and
/// overflow saturates, as the JavaScript original does not fail on it either.
pub(crate) fn parse_int_prefix(raw: &str) -> Option<i64> {
    let trimmed = raw.trim_start();
    let (negative, digits) = match trimmed.as_bytes().first() {
        Some(b'-') => (true, &trimmed[1..]),
        Some(b'+') => (false, &trimmed[1..]),
        _ => (false, trimmed),
    };
    let mut value: i64 = 0;
    let mut seen = false;
    for ch in digits.chars() {
        let Some(digit) = ch.to_digit(10) else {
            break;
        };
        seen = true;
        value = value.saturating_mul(10).saturating_add(i64::from(digit));
    }
    if !seen {
        return None;
    }
    Some(if negative { -value } else { value })
}

// ─── Chat-display trace and inbox observability (OP-2) ──────────────────────
//
// Port of `src/server/diagnostics/chatDisplayTrace.ts` and the counters of
// `src/server/channels/inbox/observability.ts`. The TypeScript originals write
// to the Node process (`console.info`, a `globalThis` counter object) and no
// route exposes the counters; the Rust port emits the same structured records
// through `tracing` and keeps the counters in process statics. The metrics
// snapshot endpoint of the TypeScript side (`getInboxObservabilitySnapshot`)
// stays unported and is documented as the remainder of OP-2.

/// `DEFAULT_CHAT_DISPLAY_SLOW_MS` (`chatDisplayTrace.ts:7`).
const DEFAULT_CHAT_DISPLAY_SLOW_MS: u64 = 1000;

/// `isEnabled` from `chatDisplayTrace.ts:10-15`: `1`, `true` and `yes`.
fn is_enabled(value: Option<&str>) -> bool {
    matches!(
        value.map(|text| text.trim().to_lowercase()).as_deref(),
        Some("1") | Some("true") | Some("yes")
    )
}

/// `isChatDisplayTraceEnabled` (`chatDisplayTrace.ts:23-25`).
pub(crate) fn chat_display_trace_enabled() -> bool {
    is_enabled(env_value("CHAT_DISPLAY_LOGS").as_deref())
        || is_enabled(env_value("INBOX_V2_LOGS").as_deref())
}

/// `getChatDisplaySlowThresholdMs` (`chatDisplayTrace.ts:27-29`).
pub(crate) fn get_chat_display_slow_threshold_ms() -> u64 {
    parse_threshold(
        env_value("CHAT_DISPLAY_SLOW_MS").as_deref(),
        DEFAULT_CHAT_DISPLAY_SLOW_MS,
    )
}

/// `parseThreshold` (`chatDisplayTrace.ts:17-21`).
pub(crate) fn parse_threshold(value: Option<&str>, fallback: u64) -> u64 {
    match value.and_then(parse_int_prefix) {
        Some(parsed) if parsed >= 0 => parsed as u64,
        _ => fallback,
    }
}

fn env_value(key: &str) -> Option<String> {
    std::env::var(key).ok()
}

/// `logChatDisplayTrace` (`chatDisplayTrace.ts:58-76`). The record carries the
/// `scope: 'chat.display'` marker and the caller's payload.
pub(crate) fn log_chat_display_trace(stage: &str, payload: &Value, force: bool) {
    let forced = force
        && (is_enabled(env_value("CHAT_DISPLAY_FORCE_LOGS").as_deref())
            || is_enabled(env_value("INBOX_V2_FORCE_LOGS").as_deref()));
    if !chat_display_trace_enabled() && !forced {
        return;
    }
    tracing::info!(
        scope = "chat.display",
        stage,
        payload = %payload,
        "chat display trace"
    );
}

/// `logInboxObservability` (`observability.ts:143-153`).
pub(crate) fn log_inbox_observability(stage: &str, payload: &Value) {
    if !chat_display_trace_enabled() {
        return;
    }
    tracing::info!(
        scope = "inbox.v2",
        stage,
        payload = %payload,
        "inbox observability"
    );
}

/// `InboxObservabilityState` counters (`observability.ts:6-17`) as process
/// statics. Only `reconnectResyncCount` has a reader a test can reach.
static QUERIES_HTTP: AtomicU64 = AtomicU64::new(0);
static EVENTS_EMITTED: AtomicU64 = AtomicU64::new(0);
static EVENTS_DROPPED: AtomicU64 = AtomicU64::new(0);
static EVENT_UPSERTS: AtomicU64 = AtomicU64::new(0);
static EVENT_DELETES: AtomicU64 = AtomicU64::new(0);
static RECONNECT_RESYNC: AtomicU64 = AtomicU64::new(0);

/// `recordInboxQueryDuration('http', …)` (`observability.ts:57-67`): only the
/// counter survives the port.
pub(crate) fn record_inbox_query_duration_http() {
    QUERIES_HTTP.fetch_add(1, Ordering::Relaxed);
}

/// `recordInboxReconnectResync` (`observability.ts:86-89`).
pub(crate) fn record_inbox_reconnect_resync() {
    RECONNECT_RESYNC.fetch_add(1, Ordering::Relaxed);
}

/// `recordInboxEventEmission` (`observability.ts:69-74`).
pub(crate) fn record_inbox_event_emission(action: &str) {
    EVENTS_EMITTED.fetch_add(1, Ordering::Relaxed);
    if action == "upsert" {
        EVENT_UPSERTS.fetch_add(1, Ordering::Relaxed);
    }
    if action == "delete" {
        EVENT_DELETES.fetch_add(1, Ordering::Relaxed);
    }
}

/// `recordInboxEventDropped` (`observability.ts:81-84`).
pub(crate) fn record_inbox_event_dropped() {
    EVENTS_DROPPED.fetch_add(1, Ordering::Relaxed);
}

/// The scalar half of `getInboxObservabilitySnapshot` (`observability.ts:91-137`).
/// The latency percentiles are not kept because the gateway has no reader. The
/// ops family reads it for `GET /api/control-plane/metrics`.
pub(crate) struct InboxObservabilityCounters {
    pub queries_http: u64,
    pub events_emitted: u64,
    pub events_dropped: u64,
    pub event_upserts: u64,
    pub event_deletes: u64,
    pub reconnect_resync_count: u64,
}

pub(crate) fn inbox_observability_counters() -> InboxObservabilityCounters {
    InboxObservabilityCounters {
        queries_http: QUERIES_HTTP.load(Ordering::Relaxed),
        events_emitted: EVENTS_EMITTED.load(Ordering::Relaxed),
        events_dropped: EVENTS_DROPPED.load(Ordering::Relaxed),
        event_upserts: EVENT_UPSERTS.load(Ordering::Relaxed),
        event_deletes: EVENT_DELETES.load(Ordering::Relaxed),
        reconnect_resync_count: RECONNECT_RESYNC.load(Ordering::Relaxed),
    }
}

/// Port of `emitInboxUpdated` (`src/server/channels/inbox/events.ts:45-77`).
/// Sends `inbox.updated` to every connection of the user, unless the events flag
/// is off. The dropped/emitted counters and the observability records are OP-2.
pub(crate) fn emit_inbox_updated(
    state: &AppState,
    user_id: &str,
    action: &str,
    conversation_id: &str,
    item: Option<InboxItemRecord>,
) {
    if !state.config.inbox_events_enabled {
        record_inbox_event_dropped();
        log_inbox_observability(
            "event.dropped",
            &json!({
                "action": action,
                "conversationId": conversation_id,
                "reason": "events_disabled",
            }),
        );
        return;
    }
    record_inbox_event_emission(action);
    log_inbox_observability(
        "event.emit",
        &json!({ "action": action, "conversationId": conversation_id }),
    );
    let payload: Value = json!({
        "version": "v2",
        "action": action,
        "conversationId": conversation_id,
        "item": item,
        "serverTs": now_iso(),
    });
    broadcast_to_user(&state.registry, user_id, INBOX_UPDATED, Some(payload));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_int_prefix_follows_parse_int() {
        assert_eq!(parse_int_prefix("42"), Some(42));
        assert_eq!(parse_int_prefix("  7abc"), Some(7));
        assert_eq!(parse_int_prefix("-3"), Some(-3));
        assert_eq!(parse_int_prefix("+5"), Some(5));
        assert_eq!(parse_int_prefix("abc"), None);
        assert_eq!(parse_int_prefix(""), None);
        assert_eq!(parse_int_prefix("99999999999999999999"), Some(i64::MAX));
    }

    #[test]
    fn parse_threshold_follows_chat_display_trace() {
        assert_eq!(parse_threshold(None, 1000), 1000);
        assert_eq!(parse_threshold(Some(""), 1000), 1000);
        assert_eq!(parse_threshold(Some("abc"), 500), 500);
        assert_eq!(parse_threshold(Some("-5"), 500), 500);
        assert_eq!(parse_threshold(Some("250"), 1000), 250);
        assert_eq!(parse_threshold(Some("12abc"), 1000), 12);
    }

    #[test]
    fn is_enabled_accepts_the_documented_spellings() {
        assert!(is_enabled(Some("1")));
        assert!(is_enabled(Some("TRUE")));
        assert!(is_enabled(Some(" yes ")));
        assert!(!is_enabled(Some("0")));
        assert!(!is_enabled(Some("no")));
        assert!(!is_enabled(None));
    }
}
