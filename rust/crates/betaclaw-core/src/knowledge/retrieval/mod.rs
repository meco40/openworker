//! Port of `src/server/knowledge/retrieval/` — the retrieval sub-package
//! (package P2 of the S7 lane).
//!
//! One module per TypeScript file; the submodules are declared by the work
//! package that ports them, so this file lists exactly what exists.
//!
//! | Rust | TypeScript |
//! | --- | --- |
//! | [`types`] | `retrieval/types.ts` |
//! | `index` | `retrieval/index.ts` (the re-export list at the bottom of this file) |
//!
//! # Rust-only seam helpers
//!
//! Three helpers have no file of their own in the TypeScript tree: they are
//! imported from `src/shared/lib/text.ts` or are JS built-ins, and more than one
//! module of this package needs them. They live here once and are
//! `pub(crate)` — plumbing, not ported behaviour.
//!
//! * [`truncate_text`] — `truncateText` from `src/shared/lib/text.ts:4-10`,
//!   used by `query/rulesExtractor.ts:3` and `formatters/contextFormatter.ts:5`.
//! * [`js_date_parse_millis`] — `Date.parse(value)` as used by
//!   `ranking/episodeRanker.ts:9` and `ranking/ledgerRanker.ts:38`.
//! * [`js_str_len`] — `String#length`, i.e. UTF-16 code units. JavaScript
//!   compares `.length` against character counts in
//!   `utils/arrayUtils`, `query/queryParser.ts:34`, `query/rulesExtractor.ts:44`
//!   and `formatters/contextFormatter.ts:31`; the port keeps the UTF-16 count
//!   so an astral character is two, like in the source.
//!
//! # Deviation
//!
//! `truncateText` cuts on a `char` boundary where the TypeScript uses
//! `String#slice`, i.e. UTF-16 code units: for a string whose cut lands inside
//! a surrogate pair the TypeScript produces a lone surrogate, which is not
//! representable as UTF-8 text. Every input of this function is stored message,
//! episode or memory text.

use std::sync::OnceLock;

use chrono::DateTime;
use regex::Regex;

pub mod formatters;
pub mod query;
pub mod ranking;
pub mod service;
pub mod types;
pub mod utils;

// Mirrors the re-export list of `retrieval/index.ts:1-52`.
pub use crate::knowledge::retrieval::query::intent_detector::{
    contains_rules_word, detect_mentioned_counterpart, is_counterpart_match, is_rules_intent_query,
    normalize_lookup_text,
};
pub use crate::knowledge::retrieval::query::query_parser::tokenize_query_for_ranking;
pub use crate::knowledge::retrieval::query::rules_extractor::{
    extract_rule_fragments, is_rule_like_statement,
};
pub use crate::knowledge::retrieval::ranking::episode_ranker::{
    compute_episode_age, rank_episodes_by_query,
};
pub use crate::knowledge::retrieval::ranking::ledger_ranker::rank_ledger_by_query;
pub use crate::knowledge::retrieval::ranking::scoring::{
    compute_token_overlap_score, detect_emotional_tone_in_text,
};
pub use crate::knowledge::retrieval::utils::unique_strings;

/// `truncateText` from `src/shared/lib/text.ts:4-10`.
///
/// Collapses whitespace, and appends `...` when the result is over the limit
/// (keeping at least one character, like `Math.max(1, maxChars - 3)`).
pub(crate) fn truncate_text(value: &str, max_chars: usize) -> String {
    let normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if js_str_len(&normalized) <= max_chars {
        return normalized;
    }
    let cut = max_chars.saturating_sub(3).max(1);
    let sliced: String = normalized.chars().take(cut).collect();
    format!("{}...", sliced.trim_end())
}

/// `String#length` — UTF-16 code units, not Unicode scalar values.
pub(crate) fn js_str_len(value: &str) -> usize {
    value.encode_utf16().count()
}

/// `Date.parse(value)` (`ranking/episodeRanker.ts:9`).
///
/// Returns milliseconds since the epoch or `NaN` for text `Date.parse` would
/// reject. The port accepts the RFC 3339 forms the knowledge stores write
/// (`…T…:…:….mmmZ`, with or without an offset) and the date-only form, which
/// JavaScript reads as UTC midnight. An offset-less date-*time* is `NaN` here
/// because JavaScript would read it in the host's local time zone, which a
/// deterministic port cannot reproduce.
pub(crate) fn js_date_parse_millis(text: &str) -> f64 {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return f64::NAN;
    }
    if let Ok(value) = DateTime::parse_from_rfc3339(trimmed) {
        return value.timestamp_millis() as f64;
    }
    if let Ok(date) = chrono::NaiveDate::parse_from_str(trimmed, "%Y-%m-%d") {
        if let Some(naive) = date.and_hms_opt(0, 0, 0) {
            return naive.and_utc().timestamp_millis() as f64;
        }
    }
    f64::NAN
}

/// Compile and cache one module-level pattern: `Regex::new` is expensive and
/// the TypeScript engine keeps each literal compiled at its call site.
pub(crate) fn pattern<'a>(source: &str, cell: &'a OnceLock<Regex>) -> &'a Regex {
    cell.get_or_init(|| Regex::new(source).expect("static regex"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncation_collapses_whitespace_and_marks_the_cut() {
        assert_eq!(truncate_text("  a  b  ", 10), "a b");
        assert_eq!(truncate_text("aaaa bbbb", 9), "aaaa bbbb");
        assert_eq!(truncate_text("aaaa bbbb", 8), "aaaa...");
        assert_eq!(truncate_text("aaaa bbbb", 1), "a...");
        assert_eq!(truncate_text("", 5), "");
    }

    #[test]
    fn the_length_is_counted_in_utf16_units_like_javascript() {
        assert_eq!(js_str_len("abc"), 3);
        assert_eq!(js_str_len("ä"), 1);
        // U+1F600 is one char but two UTF-16 code units.
        assert_eq!(js_str_len("😀"), 2);
    }

    #[test]
    fn only_the_timestamp_forms_the_stores_write_parse() {
        assert_eq!(
            js_date_parse_millis("2024-06-15T10:30:00.000Z"),
            1_718_447_400_000.0
        );
        assert_eq!(js_date_parse_millis("2024-06-15"), 1_718_409_600_000.0);
        assert_eq!(
            js_date_parse_millis("2024-06-15T10:30:00+02:00"),
            1_718_440_200_000.0
        );
        assert!(js_date_parse_millis("kein Datum").is_nan());
        assert!(js_date_parse_millis("").is_nan());
        assert!(js_date_parse_millis("2024-06-15T10:30:00").is_nan());
    }

    #[test]
    fn a_cached_pattern_is_compiled_once() {
        static CELL: OnceLock<Regex> = OnceLock::new();
        let first = pattern(r"(?i)(?-u:\b)abc(?-u:\b)", &CELL) as *const Regex;
        let second = pattern(r"(?i)(?-u:\b)abc(?-u:\b)", &CELL) as *const Regex;
        assert_eq!(first, second);
    }
}
