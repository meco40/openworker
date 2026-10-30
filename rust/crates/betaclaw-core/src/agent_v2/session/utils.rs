//! Port of `src/server/agent-v2/session/utils.ts`.

use serde::de::DeserializeOwned;

use super::constants::{DEFAULT_MAX_QUEUE_LENGTH, MAX_QUEUE_LENGTH, MIN_QUEUE_LENGTH};
use crate::agent_v2::types::{AgentSessionSnapshot, SessionStatus};

text_enum!(ApprovalResultStatus {
    Approved => "approved",
    Denied => "denied",
    NotFound => "not_found",
    ApprovalRequired => "approval_required",
});

/// `resolveMaxQueueLength`. `raw` is `AGENT_V2_MAX_QUEUE_PER_SESSION` as it was read.
/// The value is parsed the way `parseInt` does it, so `"12abc"` reads as 12.
pub fn resolve_max_queue_length(raw: Option<&str>) -> i64 {
    match parse_int_prefix(raw.unwrap_or("")) {
        Some(value) if value > 0 => value.clamp(MIN_QUEUE_LENGTH, MAX_QUEUE_LENGTH),
        _ => DEFAULT_MAX_QUEUE_LENGTH,
    }
}

/// `parseInt(text, 10)`: leading whitespace, an optional sign, then the leading digits.
/// `None` where JavaScript gives `NaN`. A value too large for `i64` clamps to `i64::MAX`.
fn parse_int_prefix(text: &str) -> Option<i64> {
    let trimmed = text.trim_start();
    let (negative, digits) = match trimmed.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, trimmed.strip_prefix('+').unwrap_or(trimmed)),
    };
    let end = digits.bytes().take_while(u8::is_ascii_digit).count();
    if end == 0 {
        return None;
    }
    let magnitude = digits[..end].parse::<i64>().unwrap_or(i64::MAX);
    Some(if negative { -magnitude } else { magnitude })
}

/// `safeJsonParse<T>`: `None` for an empty input or for text that does not parse as `T`.
pub fn safe_json_parse<T: DeserializeOwned>(value: Option<&str>) -> Option<T> {
    serde_json::from_str(value.filter(|text| !text.is_empty())?).ok()
}

/// `buildPendingSessionSnapshot`: the snapshot used before a session exists.
pub fn build_pending_session_snapshot(
    user_id: &str,
    conversation_id: &str,
    now: &str,
) -> AgentSessionSnapshot {
    AgentSessionSnapshot {
        id: "pending".into(),
        user_id: user_id.into(),
        conversation_id: conversation_id.into(),
        status: SessionStatus::Idle,
        revision: 0,
        last_seq: 0,
        queue_depth: 0,
        running_command_id: None,
        last_error: None,
        created_at: now.into(),
        updated_at: now.into(),
        completed_at: None,
    }
}

/// `buildApprovalResultMessage`.
pub fn build_approval_result_message(status: ApprovalResultStatus) -> &'static str {
    match status {
        ApprovalResultStatus::Approved => "Approval command accepted.",
        ApprovalResultStatus::Denied => "Approval denied.",
        ApprovalResultStatus::ApprovalRequired => "Another approval step is required.",
        ApprovalResultStatus::NotFound => "Approval token not found.",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn max_queue_length_reads_like_parse_int_and_clamps() {
        assert_eq!(resolve_max_queue_length(None), 64);
        assert_eq!(resolve_max_queue_length(Some("")), 64);
        assert_eq!(resolve_max_queue_length(Some("0")), 64);
        assert_eq!(resolve_max_queue_length(Some("-9")), 64);
        assert_eq!(resolve_max_queue_length(Some("abc")), 64);
        assert_eq!(resolve_max_queue_length(Some("12abc")), 12);
        assert_eq!(resolve_max_queue_length(Some("  +8")), 8);
        assert_eq!(resolve_max_queue_length(Some("2")), 4);
        assert_eq!(resolve_max_queue_length(Some("100000")), 512);
        assert_eq!(resolve_max_queue_length(Some("99999999999999999999")), 512);
    }

    #[test]
    fn safe_json_parse_returns_none_for_empty_or_broken_text() {
        assert_eq!(safe_json_parse::<i64>(Some("7")), Some(7));
        assert_eq!(safe_json_parse::<i64>(Some("")), None);
        assert_eq!(safe_json_parse::<i64>(Some("{")), None);
        assert_eq!(safe_json_parse::<i64>(None), None);
    }

    #[test]
    fn pending_snapshot_is_idle_and_empty() {
        let snapshot = build_pending_session_snapshot("u", "c", "t");
        assert_eq!(snapshot.id, "pending");
        assert_eq!(snapshot.status, SessionStatus::Idle);
        assert_eq!((snapshot.revision, snapshot.last_seq), (0, 0));
        assert_eq!(snapshot.created_at, "t");
        assert_eq!(snapshot.updated_at, "t");
    }

    #[test]
    fn approval_messages_match_the_typescript_strings() {
        assert_eq!(
            build_approval_result_message(ApprovalResultStatus::Approved),
            "Approval command accepted."
        );
        assert_eq!(
            build_approval_result_message(ApprovalResultStatus::Denied),
            "Approval denied."
        );
        assert_eq!(
            build_approval_result_message(ApprovalResultStatus::ApprovalRequired),
            "Another approval step is required."
        );
        assert_eq!(
            build_approval_result_message(ApprovalResultStatus::NotFound),
            "Approval token not found."
        );
    }
}
