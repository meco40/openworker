//! Port of `src/server/knowledge/cleanupDetector.ts` (1-52).
//!
//! | TypeScript                                         | Rust |
//! | -------------------------------------------------- | ---- |
//! | `cleanupDetector.ts:8-11` (`PLACEHOLDER_PATTERNS`)  | [`placeholder_patterns`] |
//! | `cleanupDetector.ts:13-14` (`STALE_RELATIVE_TIME`)  | [`stale_relative_time`] |
//! | `cleanupDetector.ts:17` (`STALE_THRESHOLD_MS`)      | [`STALE_THRESHOLD_MS`] |
//! | `cleanupDetector.ts:19-22` (`LOW_RELEVANCE_PATTERNS`) | [`low_relevance_patterns`] |
//! | `cleanupDetector.ts:25` (`MIN_SUBSTANTIVE_LENGTH`)  | [`MIN_SUBSTANTIVE_LENGTH`] |
//! | `cleanupDetector.ts:31-33` (`detectPlaceholder`)    | [`detect_placeholder`] |
//! | `cleanupDetector.ts:39-44` (`detectStaleRelativeTime`) | [`detect_stale_relative_time`] |
//! | `cleanupDetector.ts:49-52` (`detectLowRelevance`)   | [`detect_low_relevance`] |
//!
//! Dependency of `ingestion/service.ts`, which is S6-owned; the detector itself
//! imports nothing.
//!
//! # JavaScript semantics that are reproduced explicitly
//!
//! * `Date.now() - new Date(createdAt).getTime()` is `NaN` for an unparsable
//!   `createdAt`, and `NaN > STALE_THRESHOLD_MS` is `false`. The port returns
//!   `false` for an unparsable timestamp instead of propagating a `NaN`.
//! * `STALE_THRESHOLD_MS` is `2 * 24 * 60 * 60 * 1000` in IEEE-754 doubles; the
//!   port keeps the value as [`i64`] because every term is an exact integer.
//! * `content.trim().length` counts UTF-16 code units; the port counts `char`s,
//!   which differs only for astral-plane characters.
//! * JavaScript's `\w` is ASCII while the Rust `regex` crate's is Unicode; the
//!   `in \w+ tagen?` alternative therefore spells `[0-9A-Za-z_]+` out.
//!
//! # Deviations
//!
//! 1. **The clock is a parameter.** `detectStaleRelativeTime` reads `Date.now()`
//!    (`cleanupDetector.ts:42`) directly. The port takes `now_millis` so a unit
//!    test is deterministic, exactly like
//!    [`crate::memory::lifecycle::is_active_memory_metadata`] does for the same
//!    reason. The caller passes `Date.now()`.
//!
//! # Regex justification
//!
//! All five patterns carry word boundaries, alternation and `^…$` anchors
//! (`cleanupDetector.ts:8-22`); `regex` is the crate the workspace already
//! depends on for exactly this class of pattern (see the `regex` comment in
//! `rust/Cargo.toml`), so no second pattern engine is introduced.

use regex::Regex;
use std::sync::OnceLock;

/// `PLACEHOLDER_PATTERNS` (`cleanupDetector.ts:8-11`).
pub fn placeholder_patterns() -> &'static [Regex] {
    static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        vec![
            Regex::new(
                r"(?i)\b(die figur|der protagonist|die protagonistin|the character|the figure)\b",
            )
            .expect("placeholder pattern"),
            Regex::new(r"(?i)\b(die person|das wesen|das individuum)\b")
                .expect("placeholder pattern"),
        ]
    })
}

/// `STALE_RELATIVE_TIME` (`cleanupDetector.ts:13-14`).
pub fn stale_relative_time() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(
            r"(?i)\b(morgen|in [0-9A-Za-z_]+ tagen?|naechste woche|nächste woche|bald|demnaechst|demnächst)\b",
        )
        .expect("stale relative time pattern")
    })
}

/// `STALE_THRESHOLD_MS` (`cleanupDetector.ts:17`): two days in milliseconds.
pub const STALE_THRESHOLD_MS: i64 = 2 * 24 * 60 * 60 * 1000;

/// `LOW_RELEVANCE_PATTERNS` (`cleanupDetector.ts:19-22`).
pub fn low_relevance_patterns() -> &'static [Regex] {
    static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        vec![
            Regex::new(
                r"(?i)^(guten morgen|guten abend|guten tag|hallo|hi|hey|moin|servus|tschuess|bye)",
            )
            .expect("low relevance pattern"),
            Regex::new(r"(?i)^(ok|okay|ja|nein|danke|bitte|alles klar|gut|super|cool|nice)$")
                .expect("low relevance pattern"),
        ]
    })
}

/// `MIN_SUBSTANTIVE_LENGTH` (`cleanupDetector.ts:25`).
pub const MIN_SUBSTANTIVE_LENGTH: usize = 10;

/// `detectPlaceholder(content)` (`cleanupDetector.ts:31-33`).
///
/// A placeholder entity reference instead of a real name — e.g. "Die
/// Protagonistin" where "Nata" belongs.
pub fn detect_placeholder(content: &str) -> bool {
    placeholder_patterns().iter().any(|p| p.is_match(content))
}

/// `detectStaleRelativeTime(content, createdAt)` (`cleanupDetector.ts:39-44`).
///
/// A relative time expression is stale once the fact is older than
/// [`STALE_THRESHOLD_MS`]. `now_millis` is the caller's `Date.now()` (deviation 1).
pub fn detect_stale_relative_time(content: &str, created_at: &str, now_millis: i64) -> bool {
    if !stale_relative_time().is_match(content) {
        return false;
    }
    let Some(created) = parse_timestamp_millis(created_at) else {
        // `new Date(createdAt).getTime()` is `NaN`, so `NaN > threshold` is false.
        return false;
    };
    now_millis.saturating_sub(created) > STALE_THRESHOLD_MS
}

/// `detectLowRelevance(content)` (`cleanupDetector.ts:49-52`).
pub fn detect_low_relevance(content: &str) -> bool {
    let trimmed = content.trim();
    if trimmed.chars().count() < MIN_SUBSTANTIVE_LENGTH {
        return true;
    }
    low_relevance_patterns().iter().any(|p| p.is_match(trimmed))
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
    use chrono::SecondsFormat;

    fn iso(millis: i64) -> String {
        chrono::DateTime::from_timestamp_millis(millis)
            .expect("timestamp in range")
            .to_rfc3339_opts(SecondsFormat::Millis, true)
    }

    #[test]
    fn placeholders_are_detected_case_insensitively() {
        assert!(detect_placeholder("Die Protagonistin ist traurig"));
        assert!(detect_placeholder("the character said hello"));
        assert!(detect_placeholder("das Wesen"));
        assert!(!detect_placeholder("Nata ist traurig"));
    }

    #[test]
    fn a_relative_time_is_only_stale_beyond_two_days() {
        let now = 1_800_000_000_000_i64;
        assert!(detect_stale_relative_time(
            "wir treffen uns morgen",
            &iso(now - STALE_THRESHOLD_MS - 3_600_000),
            now
        ));
        assert!(!detect_stale_relative_time(
            "wir treffen uns morgen",
            &iso(now - 3_600_000),
            now
        ));
        // The boundary itself is not stale: `age > STALE_THRESHOLD_MS`.
        assert!(!detect_stale_relative_time(
            "morgen",
            &iso(now - STALE_THRESHOLD_MS),
            now
        ));
    }

    #[test]
    fn a_fact_without_a_relative_time_is_never_stale() {
        assert!(!detect_stale_relative_time(
            "Nata hat einen Bruder",
            "1970-01-01T00:00:00.000Z",
            1_800_000_000_000
        ));
    }

    #[test]
    fn an_unparsable_created_at_is_not_stale() {
        assert!(!detect_stale_relative_time(
            "morgen",
            "not a date",
            1_800_000_000_000
        ));
    }

    #[test]
    fn short_greetings_and_acks_are_low_relevance() {
        assert!(detect_low_relevance("hallo"));
        assert!(detect_low_relevance("okay"));
        assert!(detect_low_relevance("alles klar"));
        // Nine trimmed characters — below MIN_SUBSTANTIVE_LENGTH.
        assert!(detect_low_relevance("   kurz   "));
        assert!(!detect_low_relevance("Nata hat einen Bruder namens Max"));
        // The first pattern is anchored at the *start only* (`cleanupDetector.ts:19`),
        // so a substantive message that opens with a greeting is still low
        // relevance — Node 24 says `true` for both of these.
        assert!(detect_low_relevance("hallo Nata, wie geht es dir heute"));
        // `hi` is a prefix alternative, so it also fires inside `high`.
        assert!(detect_low_relevance("high level overview of the project"));
        assert!(!detect_low_relevance("ich mag dich"));
    }
}
