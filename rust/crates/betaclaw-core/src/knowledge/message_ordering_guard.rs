//! Port of `src/server/knowledge/messageOrderingGuard.ts` (1-64).
//!
//! | TypeScript                                    | Rust |
//! | --------------------------------------------- | ---- |
//! | `messageOrderingGuard.ts:6-13` (`IncomingMessage`) | [`IncomingMessage`] |
//! | `messageOrderingGuard.ts:15-20` (`StoredMessage`)  | [`OrderedMessage`] |
//! | `messageOrderingGuard.ts:22` (`DEFAULT_LATE_ARRIVAL_THRESHOLD_MS`) | [`DEFAULT_LATE_ARRIVAL_THRESHOLD_MS`] |
//! | `messageOrderingGuard.ts:28-39` (`createIdempotencyKey`) | [`create_idempotency_key`] |
//! | `messageOrderingGuard.ts:45-53` (`isLateArrival`)  | [`is_late_arrival`] |
//! | `messageOrderingGuard.ts:59-64` (`reorderByTimestamp`) | [`reorder_by_timestamp`] |
//!
//! Pure functions, no service dependency. Dependency of `ingestion/*`
//! (S6-owned).
//!
//! # JavaScript semantics that are reproduced explicitly
//!
//! * **The hash is a 32-bit signed integer, not a Rust `Hash`.** `hash << 5`
//!   converts to `int32` and shifts, the subtraction and the addition happen in
//!   IEEE-754 doubles, and `hash |= 0` applies `ToInt32` afterwards
//!   (`:35-36`). The port computes `(wrapping_shl(h, 5) as i64) - (h as i64) +
//!   code_unit as i64` and narrows with `as i32`, which is `ToInt32` for a
//!   value of that magnitude.
//! * `raw.charCodeAt(i)` indexes **UTF-16 code units**, so the port iterates
//!   [`str::encode_utf16`]. An astral-plane character contributes its two
//!   surrogates, exactly like the source, and `slice(0, 50)` cuts in code units
//!   too.
//! * `Math.abs(hash).toString(36)` is base-36 with lowercase digits;
//!   `Math.abs(i32::MIN)` is `2147483648`, which the port keeps as a `u64`.
//! * `new Date(x).getTime()` is `NaN` for an unparsable value, so
//!   `receivedTime - originalTime` is `NaN` and `NaN > thresholdMs` is `false`.
//! * `Array.prototype.sort` is stable and treats a `NaN` comparator result as
//!   `+0`; the port sorts with [`f64::partial_cmp`] falling back to
//!   [`Ordering::Equal`], so unparsable timestamps keep their input order.
//!
//! # Deviation
//!
//! The `StoredMessage` of this module is *not* `messages_store::StoredMessage`:
//! the TypeScript declares a local four-field interface with the same name
//! (`:15-20`) and `reorderByTimestamp` only ever reads `originalTimestamp`. The
//! port names it [`OrderedMessage`] to avoid the collision while keeping the
//! fields that are read.

use std::cmp::Ordering;

/// `IncomingMessage` (`messageOrderingGuard.ts:6-13`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IncomingMessage {
    pub channel_id: String,
    pub original_message_id: String,
    pub content: String,
    /// ISO — when the message was originally sent.
    pub original_timestamp: String,
    /// ISO — when the system received it.
    pub received_at: String,
    /// `'web' | 'whatsapp' | 'telegram'`.
    pub channel_source: String,
}

/// The local `StoredMessage` of this module (`messageOrderingGuard.ts:15-20`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OrderedMessage {
    pub id: String,
    pub content: String,
    pub original_timestamp: String,
    pub created_at: String,
}

/// `DEFAULT_LATE_ARRIVAL_THRESHOLD_MS` (`messageOrderingGuard.ts:22`):
/// five minutes in milliseconds.
pub const DEFAULT_LATE_ARRIVAL_THRESHOLD_MS: i64 = 5 * 60 * 1000;

/// `createIdempotencyKey(message)` (`messageOrderingGuard.ts:28-39`).
///
/// `channelId + originalMessageId + first 50 chars of content`, hashed into
/// `idk-<base36>`.
pub fn create_idempotency_key(message: &IncomingMessage) -> String {
    let content_prefix = truncate_code_units(&message.content, 50)
        .trim()
        .to_lowercase();
    let raw = format!(
        "{}|{}|{}",
        message.channel_id, message.original_message_id, content_prefix
    );

    let mut hash: i32 = 0;
    for code_unit in raw.encode_utf16() {
        let shifted = hash.wrapping_shl(5);
        let number = (shifted as i64) - (hash as i64) + (code_unit as i64);
        // `hash |= 0` — `ToInt32`, i.e. the low 32 bits.
        hash = number as i32;
    }

    // `Math.abs(hash)` in doubles: `i32::MIN` widens to 2147483648.
    let magnitude = (hash as i64).unsigned_abs();
    format!("idk-{}", base36(magnitude))
}

/// `isLateArrival(message, thresholdMs)` (`messageOrderingGuard.ts:45-53`).
pub fn is_late_arrival(message: &IncomingMessage, threshold_ms: i64) -> bool {
    let (Some(original), Some(received)) = (
        parse_timestamp_millis(&message.original_timestamp),
        parse_timestamp_millis(&message.received_at),
    ) else {
        // `NaN > thresholdMs` is `false` when either side is unparsable.
        return false;
    };
    received - original > threshold_ms
}

/// `isLateArrival(message)` with the default threshold
/// (`messageOrderingGuard.ts:47`).
pub fn is_late_arrival_default(message: &IncomingMessage) -> bool {
    is_late_arrival(message, DEFAULT_LATE_ARRIVAL_THRESHOLD_MS)
}

/// `reorderByTimestamp(messages)` (`messageOrderingGuard.ts:59-64`).
///
/// Returns a new vector — the input is not mutated.
pub fn reorder_by_timestamp(messages: &[OrderedMessage]) -> Vec<OrderedMessage> {
    let mut sorted = messages.to_vec();
    sorted.sort_by(|left, right| {
        let left_time = parse_timestamp_millis(&left.original_timestamp);
        let right_time = parse_timestamp_millis(&right.original_timestamp);
        // `NaN` comparator results behave as `+0`, and `sort` is stable.
        match (left_time, right_time) {
            (Some(left_time), Some(right_time)) => left_time.cmp(&right_time),
            _ => Ordering::Equal,
        }
    });
    sorted
}

/// `String.prototype.slice(0, 50)` — **UTF-16 code units**, not bytes.
fn truncate_code_units(text: &str, max_units: usize) -> String {
    let units: Vec<u16> = text.encode_utf16().take(max_units).collect();
    String::from_utf16_lossy(&units)
}

/// `Number.prototype.toString(36)` for a non-negative integer.
fn base36(mut value: u64) -> String {
    const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if value == 0 {
        return "0".to_string();
    }
    let mut out = Vec::new();
    while value > 0 {
        out.push(DIGITS[(value % 36) as usize]);
        value /= 36;
    }
    out.reverse();
    String::from_utf8(out).expect("base36 alphabet is ASCII")
}

/// `new Date(text).getTime()`, using the ISO coverage of `parse_iso`.
fn parse_timestamp_millis(text: &str) -> Option<i64> {
    crate::knowledge::repositories::utils::parse_iso(Some(text))
        .and_then(|normalized| chrono::DateTime::parse_from_rfc3339(&normalized).ok())
        .map(|parsed| parsed.timestamp_millis())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(content: &str, original: &str, received: &str) -> IncomingMessage {
        IncomingMessage {
            channel_id: "web".to_string(),
            original_message_id: "m-1".to_string(),
            content: content.to_string(),
            original_timestamp: original.to_string(),
            received_at: received.to_string(),
            channel_source: "web".to_string(),
        }
    }

    fn stored(id: &str, timestamp: &str) -> OrderedMessage {
        OrderedMessage {
            id: id.to_string(),
            content: id.to_string(),
            original_timestamp: timestamp.to_string(),
            created_at: timestamp.to_string(),
        }
    }

    /// The value below is what Node 24 prints for the same input; it pins the
    /// `ToInt32` narrowing and the base-36 rendering together.
    #[test]
    fn the_idempotency_key_matches_the_node_output() {
        assert_eq!(
            create_idempotency_key(&message(
                "Hallo Welt",
                "2026-01-02T03:04:05.000Z",
                "2026-01-02T03:04:05.000Z"
            )),
            "idk-54jq4z"
        );
    }

    #[test]
    fn the_key_is_stable_for_equivalent_inputs_and_lowercases_the_prefix() {
        let upper = message(
            "HALLO WELT",
            "2026-01-02T03:04:05.000Z",
            "2026-01-02T03:04:05.000Z",
        );
        let lower = message(
            "hallo welt",
            "2026-01-02T03:04:05.000Z",
            "2026-01-02T03:04:05.000Z",
        );
        assert_eq!(
            create_idempotency_key(&upper),
            create_idempotency_key(&lower)
        );
    }

    #[test]
    fn the_prefix_is_cut_at_fifty_code_units() {
        let long = format!("{}tail", "a".repeat(50));
        let other = format!("{}something else", "a".repeat(50));
        assert_eq!(
            create_idempotency_key(&message(&long, "m", "2026-01-02T03:04:05.000Z")),
            create_idempotency_key(&message(&other, "m", "2026-01-02T03:04:05.000Z"))
        );
        // 49 characters already differ in the prefix.
        let shorter = format!("{}tail", "a".repeat(49));
        assert_ne!(
            create_idempotency_key(&message(&long, "m", "2026-01-02T03:04:05.000Z")),
            create_idempotency_key(&message(&shorter, "m", "2026-01-02T03:04:05.000Z"))
        );
    }

    #[test]
    fn base36_renders_zero_and_a_large_value() {
        assert_eq!(base36(0), "0");
        assert_eq!(base36(35), "z");
        assert_eq!(base36(36), "10");
        assert_eq!(base36(2_147_483_648), "zik0zk");
    }

    #[test]
    fn a_late_arrival_needs_more_than_five_minutes_by_default() {
        let exactly_five = message("x", "2026-01-02T03:00:00.000Z", "2026-01-02T03:05:00.000Z");
        assert!(!is_late_arrival_default(&exactly_five));
        let over_five = message("x", "2026-01-02T03:00:00.000Z", "2026-01-02T03:05:00.001Z");
        assert!(is_late_arrival_default(&over_five));
    }

    #[test]
    fn an_earlier_received_at_is_never_late() {
        let negative = message("x", "2026-01-02T03:00:00.000Z", "2026-01-02T02:00:00.000Z");
        assert!(!is_late_arrival_default(&negative));
    }

    #[test]
    fn an_unparsable_timestamp_is_never_late() {
        let broken = message("x", "not a date", "2026-01-02T03:05:00.000Z");
        assert!(!is_late_arrival_default(&broken));
    }

    #[test]
    fn reordering_sorts_ascending_and_leaves_the_input_alone() {
        let messages = vec![
            stored("c", "2026-01-03T00:00:00.000Z"),
            stored("a", "2026-01-01T00:00:00.000Z"),
            stored("b", "2026-01-02T00:00:00.000Z"),
        ];
        let sorted = reorder_by_timestamp(&messages);
        assert_eq!(
            sorted.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            vec!["a", "b", "c"]
        );
        assert_eq!(messages[0].id, "c", "input untouched");
    }

    #[test]
    fn equal_and_unparsable_timestamps_keep_their_input_order() {
        let messages = vec![
            stored("first", "not a date"),
            stored("second", "2026-01-01T00:00:00.000Z"),
            stored("third", "not a date"),
        ];
        let sorted = reorder_by_timestamp(&messages);
        assert_eq!(
            sorted.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            vec!["first", "second", "third"]
        );
    }
}
