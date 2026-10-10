//! Helpers shared by the migrated channel routes.
//!
//! Conversations, messages, inbox and channel state answer with the same error
//! shapes and the same inbox events as their TypeScript originals, so the
//! helpers live in one place.

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

/// Port of `emitInboxUpdated` (`src/server/channels/inbox/events.ts`). Sends
/// `inbox.updated` to every connection of the user, unless the events flag is off.
pub(crate) fn emit_inbox_updated(
    state: &AppState,
    user_id: &str,
    action: &str,
    conversation_id: &str,
    item: Option<InboxItemRecord>,
) {
    if !state.config.inbox_events_enabled {
        return;
    }
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
}
