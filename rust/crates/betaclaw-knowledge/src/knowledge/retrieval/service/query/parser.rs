//! Port of `src/server/knowledge/retrieval/service/query/parser.ts` (1-25).
//!
//! | TypeScript                                        | Rust |
//! | ------------------------------------------------- | ---- |
//! | `service/query/parser.ts:1-6` (`normalizeRuleText`) | [`normalize_rule_text`] |
//! | `service/query/parser.ts:8-13` (`tokenizeRuleText`) | [`tokenize_rule_text`] |
//! | `service/query/parser.ts:15-25` (`parseEventSeqs`)  | [`parse_event_seqs`] |
//!
//! # Deviations
//!
//! 1. **`/[^a-z0-9äöüß]+/i` becomes `(?i)[^a-z0-9äöüß]+`.** Input is already
//!    lower-cased by [`normalize_rule_text`]; `(?i)` is kept so the class still
//!    reads like the source, and Rust's simple case folding does not change the
//!    membership of `ß`.
//! 2. **`token.length >= 4` is UTF-16.** [`crate::knowledge::retrieval::js_str_len`]
//!    keeps the JavaScript count.
//! 3. **`parseEventSeqs` handles the stored shapes.** The column holds a JSON
//!    array of numbers (`JSON.stringify` of the refs); each element is read with
//!    `as_f64` and anything else maps to `0`, which `Number(value || 0)` would
//!    also drop. The `try`/`catch` of `JSON.parse` becomes the `Err` arm.

use std::sync::OnceLock;

use regex::Regex;

use crate::knowledge::retrieval::{js_str_len, pattern};

static SEPARATORS: OnceLock<Regex> = OnceLock::new();

/// `normalizeRuleText` from `service/query/parser.ts:1-6`.
pub fn normalize_rule_text(value: &str) -> String {
    value
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// `tokenizeRuleText` from `service/query/parser.ts:8-13`.
pub fn tokenize_rule_text(value: &str) -> Vec<String> {
    let separators = pattern(r"(?i)[^a-z0-9äöüß]+", &SEPARATORS);
    separators
        .split(&normalize_rule_text(value))
        .map(|token| token.trim().to_string())
        .filter(|token| js_str_len(token) >= 4)
        .collect()
}

/// `parseEventSeqs` from `service/query/parser.ts:15-25`.
pub fn parse_event_seqs(source_seq_json: &str) -> Vec<i64> {
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(source_seq_json) else {
        return Vec::new();
    };
    let serde_json::Value::Array(values) = parsed else {
        return Vec::new();
    };
    values
        .into_iter()
        .map(|value| value.as_f64().unwrap_or(0.0).floor())
        .filter(|seq| seq.is_finite() && *seq > 0.0)
        .map(|seq| seq as i64)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalization_collapses_whitespace_and_lowercases() {
        assert_eq!(normalize_rule_text("  A  B  "), "a b");
    }

    #[test]
    fn tokenization_splits_on_non_word_characters_and_drops_short_tokens() {
        assert_eq!(
            tokenize_rule_text("Immer-hoeflich, bitte; Sauna"),
            vec!["immer", "hoeflich", "bitte", "sauna"]
        );
    }

    #[test]
    fn seqs_are_parsed_and_non_positive_values_dropped() {
        assert_eq!(parse_event_seqs("[1,2,0,-3,4]"), vec![1, 2, 4]);
        assert_eq!(parse_event_seqs("{\"a\":1}"), Vec::<i64>::new());
        assert_eq!(parse_event_seqs("nicht json"), Vec::<i64>::new());
    }
}
