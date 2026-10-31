//! Port of `src/server/knowledge/retrieval/query/intentDetector.ts` (1-55).
//!
//! | TypeScript                                          | Rust |
//! | --------------------------------------------------- | ---- |
//! | `query/intentDetector.ts:3-4` (`RULES_WORD_PATTERN`)  | [`rules_word_pattern`] |
//! | `query/intentDetector.ts:6-8` (`isRulesIntentQuery`)  | [`is_rules_intent_query`] |
//! | `query/intentDetector.ts:10-12` (`containsRulesWord`) | [`contains_rules_word`] |
//! | `query/intentDetector.ts:14-22` (`normalizeLookupText`) | [`normalize_lookup_text`] |
//! | `query/intentDetector.ts:24-49` (`detectMentionedCounterpart`) | [`detect_mentioned_counterpart`] |
//! | `query/intentDetector.ts:51-55` (`isCounterpartMatch`) | [`is_counterpart_match`] |
//!
//! # Deviations
//!
//! 1. **`normalize` is a hand-written fold.** `String#normalize('NFKD')` has no
//!    counterpart in the workspace dependency set (there is no
//!    `unicode-normalization` crate), so [`fold_nfkd`] carries the canonical
//!    decompositions of the Latin-1 Supplement and Latin Extended-A letters plus
//!    the combining-mark strip of `:17`. Not reproduced are the *compatibility*
//!    decompositions, which NFKD also applies: ligatures (`ﬁ`, `Ĳ`), superscripts
//!    (`²`), fraction forms (`½`) and fullwidth forms expand in JavaScript but
//!    land on the `[^a-z0-9\s-]` rule here, i.e. become a space. For German and
//!    English knowledge text the two agree.
//! 2. **Lowercasing before the class replacement.** The source lowercases after
//!    stripping combining marks; the port lowercases after folding, which is the
//!    same string for the mapped characters.
//! 3. `\s` is Rust's `White_Space` (see [`super::super`]) and `toLowerCase` is
//!    Rust's Unicode-aware `to_lowercase`.
//!
//! The pattern of `:3-4` is transcribed with `(?i)` for `/i` and `(?-u:\b)`,
//! because JavaScript defines `\b` through the ASCII class `[A-Za-z0-9_]`.

use std::collections::HashSet;
use std::sync::OnceLock;

use regex::Regex;

use super::super::{js_str_len, pattern};
use crate::knowledge::retrieval::utils::unique_strings;

/// The five normalised words of `RULES_WORD_PATTERN` (`:3-4`).
fn rules_word_pattern() -> &'static Regex {
    static RULES_WORD_PATTERN: OnceLock<Regex> = OnceLock::new();
    pattern(
        r"(?i)(?-u:\b)(regel|regeln|rule|rules|richtlinie|richtlinien|policy|policies|vorgabe|vorgaben)(?-u:\b)",
        &RULES_WORD_PATTERN,
    )
}

/// `isRulesIntentQuery` from `:6-8`.
pub fn is_rules_intent_query(query: &str) -> bool {
    rules_word_pattern().is_match(&normalize_lookup_text(query))
}

/// `containsRulesWord` from `:10-12`.
pub fn contains_rules_word(value: &str) -> bool {
    rules_word_pattern().is_match(&normalize_lookup_text(value))
}

/// The NFKD fold + combining-mark strip of `String#normalize('NFKD')` and
/// `replace(/[\u0300-\u036f]/g, '')` (`:16-17`) — see the module header.
fn fold_nfkd(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    for character in value.chars() {
        // `[U+0300, U+036F]` are removed, not replaced by a space.
        if ('\u{0300}'..='\u{036f}').contains(&character) {
            continue;
        }
        let folded = match character {
            'À' | 'Á' | 'Â' | 'Ã' | 'Ä' | 'Å' | 'Ā' | 'Ă' | 'Ą' => 'A',
            'Ç' | 'Ć' | 'Ĉ' | 'Ċ' | 'Č' => 'C',
            'Ď' | 'Đ' => 'D',
            'È' | 'É' | 'Ê' | 'Ë' | 'Ē' | 'Ĕ' | 'Ė' | 'Ę' | 'Ě' => 'E',
            'Ĝ' | 'Ğ' | 'Ġ' | 'Ģ' => 'G',
            'Ĥ' | 'Ħ' => 'H',
            'Ì' | 'Í' | 'Î' | 'Ï' | 'Ĩ' | 'Ī' | 'Ĭ' | 'Į' | 'İ' => 'I',
            'Ĵ' => 'J',
            'Ķ' => 'K',
            'Ĺ' | 'Ļ' | 'Ľ' | 'Ŀ' | 'Ł' => 'L',
            'Ñ' | 'Ń' | 'Ņ' | 'Ň' => 'N',
            'Ò' | 'Ó' | 'Ô' | 'Õ' | 'Ö' | 'Ō' | 'Ŏ' | 'Ő' => 'O',
            'Ŕ' | 'Ŗ' | 'Ř' => 'R',
            'Ś' | 'Ŝ' | 'Ş' | 'Š' => 'S',
            'Ţ' | 'Ť' | 'Ŧ' => 'T',
            'Ù' | 'Ú' | 'Û' | 'Ü' | 'Ũ' | 'Ū' | 'Ŭ' | 'Ů' | 'Ű' | 'Ų' => 'U',
            'Ŵ' => 'W',
            'Ý' | 'Ŷ' | 'Ÿ' => 'Y',
            'Ź' | 'Ż' | 'Ž' => 'Z',
            'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' | 'ā' | 'ă' | 'ą' => 'a',
            'ç' | 'ć' | 'ĉ' | 'ċ' | 'č' => 'c',
            'ď' | 'đ' => 'd',
            'è' | 'é' | 'ê' | 'ë' | 'ē' | 'ĕ' | 'ė' | 'ę' | 'ě' => 'e',
            'ĝ' | 'ğ' | 'ġ' | 'ģ' => 'g',
            'ĥ' | 'ħ' => 'h',
            'ì' | 'í' | 'î' | 'ï' | 'ĩ' | 'ī' | 'ĭ' | 'į' | 'ı' => 'i',
            'ĵ' => 'j',
            'ķ' => 'k',
            'ĺ' | 'ļ' | 'ľ' | 'ŀ' | 'ł' => 'l',
            'ñ' | 'ń' | 'ņ' | 'ň' => 'n',
            'ò' | 'ó' | 'ô' | 'õ' | 'ö' | 'ō' | 'ŏ' | 'ő' => 'o',
            'ŕ' | 'ŗ' | 'ř' => 'r',
            'ś' | 'ŝ' | 'ş' | 'š' => 's',
            'ţ' | 'ť' | 'ŧ' => 't',
            'ù' | 'ú' | 'û' | 'ü' | 'ũ' | 'ū' | 'ŭ' | 'ů' | 'ű' | 'ų' => 'u',
            'ŵ' => 'w',
            'ý' | 'ÿ' | 'ŷ' => 'y',
            'ź' | 'ż' | 'ž' => 'z',
            other => other,
        };
        output.push(folded);
    }
    output
}

/// `normalizeLookupText` from `:14-22`.
pub fn normalize_lookup_text(value: &str) -> String {
    let lowered = fold_nfkd(value).to_lowercase();
    let mut replaced = String::with_capacity(lowered.len());
    for character in lowered.chars() {
        if character.is_ascii_lowercase()
            || character.is_ascii_digit()
            || character.is_whitespace()
            || character == '-'
        {
            replaced.push(character);
        } else {
            replaced.push(' ');
        }
    }
    replaced.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// `detectMentionedCounterpart` from `:24-49`.
///
/// Candidates are tried longest-first; a candidate matches when *every* one of
/// its tokens of two or more characters occurs in the query tokens.
pub fn detect_mentioned_counterpart(query: &str, candidates: &[String]) -> Option<String> {
    let query_tokens: HashSet<String> = normalize_lookup_text(query)
        .split(' ')
        .map(|token| token.trim().to_string())
        .filter(|token| js_str_len(token) >= 2)
        .collect();
    if query_tokens.is_empty() {
        return None;
    }

    let mut ordered_candidates: Vec<String> = unique_strings(candidates)
        .into_iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect();
    // `sort((left, right) => right.length - left.length)`: longest first, and
    // `Array#sort` is stable, so equal lengths keep their input order.
    ordered_candidates.sort_by_key(|value| std::cmp::Reverse(js_str_len(value)));

    for candidate in ordered_candidates {
        let tokens: Vec<String> = normalize_lookup_text(&candidate)
            .split(' ')
            .map(|token| token.trim().to_string())
            .filter(|token| js_str_len(token) >= 2)
            .collect();
        if tokens.is_empty() {
            continue;
        }
        if tokens.iter().all(|token| query_tokens.contains(token)) {
            return Some(candidate);
        }
    }

    None
}

/// `isCounterpartMatch` from `:51-55`.
///
/// `formatters/displayUtils.ts:21-25` repeats this function byte for byte; the
/// port keeps the single implementation here and re-exports it there.
pub fn is_counterpart_match(value: &str, counterpart: &str) -> bool {
    let left = normalize_lookup_text(value);
    let right = normalize_lookup_text(counterpart);
    !left.is_empty() && !right.is_empty() && left == right
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalization_folds_umlauts_and_collapses_the_rest() {
        assert_eq!(
            normalize_lookup_text("Regeln für Sauna!"),
            "regeln fur sauna"
        );
        assert_eq!(
            normalize_lookup_text("  Über   den   Vertrag "),
            "uber den vertrag"
        );
        assert_eq!(normalize_lookup_text("Straße"), "stra e");
        assert_eq!(normalize_lookup_text("a\u{0301}b"), "ab");
        assert_eq!(normalize_lookup_text(""), "");
        assert_eq!(normalize_lookup_text("a-b"), "a-b");
        assert_eq!(normalize_lookup_text("123"), "123");
    }

    #[test]
    fn the_rules_word_pattern_needs_a_word_boundary() {
        assert!(is_rules_intent_query("Was sind die Regeln?"));
        assert!(is_rules_intent_query("policy"));
        assert!(contains_rules_word("richtlinie"));
        assert!(!is_rules_intent_query("regelwerk"));
        assert!(!is_rules_intent_query("Sauna"));
    }

    #[test]
    fn a_counterpart_is_the_longest_candidate_whose_tokens_all_occur() {
        let candidates = vec!["Max".to_string(), "Max Mustermann".to_string()];
        assert_eq!(
            detect_mentioned_counterpart("gestern mit Max Mustermann", &candidates),
            Some("Max Mustermann".to_string())
        );
        assert_eq!(
            detect_mentioned_counterpart("gestern mit Max", &candidates),
            Some("Max".to_string())
        );
        assert_eq!(
            detect_mentioned_counterpart("gestern mit Nata", &candidates),
            None
        );
        // A one-character candidate token cannot match anything.
        let single = vec!["X".to_string()];
        assert_eq!(detect_mentioned_counterpart("gestern mit X", &single), None);
        assert_eq!(detect_mentioned_counterpart("", &candidates), None);
    }

    #[test]
    fn the_counterpart_match_compares_normalized_text() {
        assert!(is_counterpart_match("Müller", "muller"));
        assert!(is_counterpart_match(" max ", "Max"));
        assert!(!is_counterpart_match("", "Max"));
        assert!(!is_counterpart_match("Max", ""));
        assert!(!is_counterpart_match("Max", "Nata"));
    }
}
