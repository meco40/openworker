//! Port of `src/server/knowledge/retrieval/service/constants.ts` (1-21).
//!
//! | TypeScript                                          | Rust |
//! | --------------------------------------------------- | ---- |
//! | `service/constants.ts:1-2` (`BINARY_RECALL_QUERY_PATTERN`) | [`binary_recall_query_pattern`] |
//! | `service/constants.ts:4` (`NEGATION_SIGNAL_PATTERN`)  | [`negation_signal_pattern`] |
//! | `service/constants.ts:6-19` (`GENERIC_QUERY_TOKENS`)  | [`GENERIC_QUERY_TOKENS`] |
//! | `service/constants.ts:21` (`COUNTERPART_CACHE_TTL_MS`)| [`COUNTERPART_CACHE_TTL_MS`] |
//!
//! A compiled `Regex` is not a `const`, so the two literals become cached
//! accessors (same transcription convention as the rest of the package:
//! `(?i)` for `/i`, `(?-u:\b)` for JavaScript's ASCII `\b`).

use std::sync::OnceLock;

use regex::Regex;

use crate::knowledge::retrieval::pattern;

/// `BINARY_RECALL_QUERY_PATTERN` from `service/constants.ts:1-2`.
pub fn binary_recall_query_pattern() -> &'static Regex {
    static BINARY_RECALL_QUERY_PATTERN: OnceLock<Regex> = OnceLock::new();
    pattern(
        r"(?i)(?-u:\b)(waren wir|haben wir|war das|stimmt das|did we|were we|have we)(?-u:\b)",
        &BINARY_RECALL_QUERY_PATTERN,
    )
}

/// `NEGATION_SIGNAL_PATTERN` from `service/constants.ts:4`.
pub fn negation_signal_pattern() -> &'static Regex {
    static NEGATION_SIGNAL_PATTERN: OnceLock<Regex> = OnceLock::new();
    pattern(
        r"(?i)(?-u:\b)(nicht|kein|keine|keinen|keinem|nie|niemals|never|no)(?-u:\b)",
        &NEGATION_SIGNAL_PATTERN,
    )
}

/// `GENERIC_QUERY_TOKENS` from `service/constants.ts:6-19` — the twelve entries
/// in the source's set order.
pub const GENERIC_QUERY_TOKENS: [&str; 12] = [
    "waren", "haben", "schon", "mal", "einmal", "zusammen", "wir", "with", "ever", "did", "were",
    "have",
];

/// `COUNTERPART_CACHE_TTL_MS` from `service/constants.ts:21`.
pub const COUNTERPART_CACHE_TTL_MS: f64 = 5.0 * 60.0 * 1000.0;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_patterns_mirror_the_source_literals() {
        assert!(binary_recall_query_pattern().is_match("waren wir damals da"));
        assert!(binary_recall_query_pattern().is_match("DID WE meet"));
        assert!(!binary_recall_query_pattern().is_match("die sauna war warm"));
        assert!(negation_signal_pattern().is_match("nein, nie"));
        assert!(!negation_signal_pattern().is_match("immer"));
        assert_eq!(GENERIC_QUERY_TOKENS.len(), 12);
        assert_eq!(COUNTERPART_CACHE_TTL_MS, 300_000.0);
    }
}
