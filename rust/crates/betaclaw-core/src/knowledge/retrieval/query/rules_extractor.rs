//! Port of `src/server/knowledge/retrieval/query/rulesExtractor.ts` (1-73).
//!
//! | TypeScript                                          | Rust |
//! | --------------------------------------------------- | ---- |
//! | `query/rulesExtractor.ts:5-26` (`isRuleLikeStatement`) | [`is_rule_like_statement`] |
//! | `query/rulesExtractor.ts:28-73` (`extractRuleFragments`) | [`extract_rule_fragments`] |
//!
//! # Pattern transcription
//!
//! `/i` becomes `(?i)` and every `\b` becomes `(?-u:\b)`, because JavaScript
//! defines `\b`/`\w` through the ASCII class `[A-Za-z0-9_]` and the Rust `regex`
//! crate through the Unicode `\w` by default (see `intent_detector.rs` for the
//! same convention). `.` keeps "any character except a line terminator" in both
//! engines; `\s` is Rust's `White_Space`, which differs from JavaScript's `\s`
//! only in `U+0085`.
//!
//! # Deviations
//!
//! 1. **Two look-around splits are hand-written.** The `regex` crate has no
//!    lookbehind and no lookahead, so the two `String#split` calls of `:36` and
//!    `:53` are reproduced by [`split_numbered_parts`] and
//!    [`split_rule_segments`] with the same leftmost-match, ordered-alternative
//!    semantics; see the function comments.
//! 2. **`String#length` is UTF-16.** The four `.length` reads of `:44`, `:55`,
//!    `:60` and `:62` count UTF-16 code units; [`super::super::js_str_len`] keeps
//!    that count. Likewise `truncateText` cuts on a char boundary where the
//!    TypeScript cuts on a UTF-16 boundary (module note in [`super::super`]).

use std::sync::OnceLock;

use regex::Regex;

use super::super::{js_str_len, pattern, truncate_text};
use super::intent_detector::{contains_rules_word, normalize_lookup_text};
use crate::knowledge::retrieval::utils::unique_strings;

static NEGATED_RULE: OnceLock<Regex> = OnceLock::new();
static NUMBERED_HEAD: OnceLock<Regex> = OnceLock::new();
static RULE_HEADER_COLON: OnceLock<Regex> = OnceLock::new();
static RULE_THEN_VERB: OnceLock<Regex> = OnceLock::new();
static RULES_HEADER: OnceLock<Regex> = OnceLock::new();
static STRIP_HEADER: OnceLock<Regex> = OnceLock::new();
static STRIP_ABSCHNITT: OnceLock<Regex> = OnceLock::new();
static NUMBERED_CANDIDATE: OnceLock<Regex> = OnceLock::new();
static NUMBERED_ONLY: OnceLock<Regex> = OnceLock::new();
static SEGMENT_HEADER: OnceLock<Regex> = OnceLock::new();
static SEGMENT_NUMBERED: OnceLock<Regex> = OnceLock::new();
static SPLIT_NEWLINE: OnceLock<Regex> = OnceLock::new();
static SPLIT_WS: OnceLock<Regex> = OnceLock::new();
static NUM_SPLIT_HEAD: OnceLock<Regex> = OnceLock::new();

const RULE_WORDS: &str =
    "regel|regeln|rule|rules|richtlinie|richtlinien|policy|policies|vorgabe|vorgaben";
const RULE_HEADS: &str = "regeln?|rules?|richtlinien?|vorgaben?";

/// `isRuleLikeStatement` from `query/rulesExtractor.ts:5-26`.
pub fn is_rule_like_statement(value: &str) -> bool {
    let normalized = normalize_lookup_text(value);
    if normalized.is_empty() {
        return false;
    }
    let negated = pattern(
        &format!(
            r"(?i)(?-u:\b)(ohne|kein|keine|keinen|nicht)(?-u:\b).{{0,24}}(?-u:\b)({RULE_WORDS})(?-u:\b)"
        ),
        &NEGATED_RULE,
    );
    if negated.is_match(&normalized) {
        return false;
    }
    if pattern(r"^\s*\d+\s*[.)-]", &NUMBERED_HEAD).is_match(value) {
        return true;
    }
    if pattern(
        &format!(r"(?i)^\s*({RULE_HEADS})(?-u:\b).{{0,24}}[:-]"),
        &RULE_HEADER_COLON,
    )
    .is_match(value)
    {
        return true;
    }
    if contains_rules_word(&normalized)
        && pattern(
            &format!(
                r"(?i)(?-u:\b)({RULE_WORDS})(?-u:\b).{{0,28}}(\d+\s*[.)]|gilt|gelten|lauten|sind)(?-u:\b)"
            ),
            &RULE_THEN_VERB,
        )
        .is_match(&normalized)
    {
        return true;
    }
    false
}

/// The `String#length` of `text.replace(/[0-9.\-\s]/g, '')` (`:44`, `:55`,
/// `:60`).
fn significant_length(text: &str) -> usize {
    let kept: String = text
        .chars()
        .filter(|character| {
            !(character.is_ascii_digit()
                || *character == '.'
                || *character == '-'
                || character.is_whitespace())
        })
        .collect();
    js_str_len(&kept)
}

/// `text.split(/\s(?=\d+\s*[.)-]\s)/)` (`:36`).
///
/// The delimiter is a single whitespace character whose immediate successors
/// match `\d+\s*[.)-]\s`; the numbered token itself stays in the next part.
fn split_numbered_parts(text: &str) -> Vec<String> {
    let head = pattern(r"^\d+\s*[.)-]\s", &NUM_SPLIT_HEAD);
    let mut parts = Vec::new();
    let mut last = 0usize;
    for (index, character) in text.char_indices() {
        if character.is_whitespace() {
            let after = index + character.len_utf8();
            if head.is_match(&text[after..]) {
                parts.push(text[last..index].to_string());
                last = after;
            }
        }
    }
    parts.push(text[last..].to_string());
    parts
}

/// `raw.split(/\r?\n+|(?<=[.!?])\s+/)` (`:52-53`).
///
/// Scans left to right and, at each position, tries `\r?\n+` first and then a
/// whitespace run that is preceded by `.`, `!` or `?`, exactly the alternative
/// order of the source pattern. The lookbehind is zero-width, so the
/// punctuation stays in the preceding segment.
fn split_rule_segments(raw: &str) -> Vec<String> {
    let newline = pattern(r"\r?\n+", &SPLIT_NEWLINE);
    let whitespace = pattern(r"\s+", &SPLIT_WS);
    let length = raw.len();
    let mut segments = Vec::new();
    let mut last = 0usize;
    let mut position = 0usize;
    while position < length {
        if !raw.is_char_boundary(position) {
            position += 1;
            continue;
        }
        let rest = &raw[position..];
        if let Some(found) = newline.find(rest).filter(|found| found.start() == 0) {
            segments.push(raw[last..position].to_string());
            let end = position + found.end();
            last = end;
            position = end;
            continue;
        }
        if position > 0 {
            let previous = raw[..position].chars().next_back();
            if matches!(previous, Some('.') | Some('!') | Some('?')) {
                if let Some(found) = whitespace.find(rest).filter(|found| found.start() == 0) {
                    segments.push(raw[last..position].to_string());
                    let end = position + found.end();
                    last = end;
                    position = end;
                    continue;
                }
            }
        }
        position += 1;
    }
    segments.push(raw[last..].to_string());
    segments
}

/// `extractRuleFragments` from `query/rulesExtractor.ts:28-73`.
pub fn extract_rule_fragments(text: &str, max_fragments: usize) -> Vec<String> {
    let raw = text.trim();
    if raw.is_empty() {
        return Vec::new();
    }
    let compact = raw.split_whitespace().collect::<Vec<_>>().join(" ");

    let strip_header = pattern(&format!(r"(?i)^({RULE_HEADS})\s*:\s*"), &STRIP_HEADER);
    let strip_abschnitt = pattern(r"(?i)^Abschnitt\s+\d+:\s*", &STRIP_ABSCHNITT);
    let numbered_candidate = pattern(r"^\d+\s*[.)-]\s+", &NUMBERED_CANDIDATE);

    let mut numbered_rule_candidates: Vec<String> = Vec::new();
    let rules_header = pattern(&format!(r"(?i)({RULE_HEADS})\s*:"), &RULES_HEADER);
    let numbered_scan_source: String = match rules_header.find(&compact) {
        Some(found) => compact[found.start()..].to_string(),
        None => compact.clone(),
    };
    for part in split_numbered_parts(&numbered_scan_source) {
        let candidate = strip_abschnitt
            .replace(&strip_header.replace(&part, ""), "")
            .trim()
            .to_string();
        if !numbered_candidate.is_match(&candidate) {
            continue;
        }
        let candidate = truncate_text(&candidate, 220);
        if significant_length(&candidate) < 4 {
            continue;
        }
        numbered_rule_candidates.push(candidate);
        if numbered_rule_candidates.len() >= max_fragments {
            break;
        }
    }
    if !numbered_rule_candidates.is_empty() {
        return unique_strings(numbered_rule_candidates);
    }

    let numbered_only = pattern(r"^\s*\d+\s*[.)-]?\s*$", &NUMBERED_ONLY);
    let segment_header = pattern(&format!(r"(?i)^\s*({RULE_HEADS})(?-u:\b)"), &SEGMENT_HEADER);
    let segment_numbered = pattern(r"^\s*\d+\s*[.)-]", &SEGMENT_NUMBERED);

    let segments: Vec<String> = split_rule_segments(raw)
        .into_iter()
        .map(|part| strip_abschnitt.replace(&part, "").trim().to_string())
        .filter(|part| !part.is_empty())
        .collect();

    let mut picks: Vec<String> = Vec::new();
    for segment in segments {
        if numbered_only.is_match(&segment) {
            continue;
        }
        if significant_length(&segment) < 4 {
            continue;
        }
        if js_str_len(&segment) > 260
            && !segment_header.is_match(&segment)
            && !segment_numbered.is_match(&segment)
        {
            continue;
        }
        if !is_rule_like_statement(&segment) {
            continue;
        }
        picks.push(truncate_text(&segment, 220));
        if picks.len() >= max_fragments {
            break;
        }
    }
    unique_strings(picks)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_numbered_list_is_rule_like_and_a_negated_rule_is_not() {
        assert!(is_rule_like_statement("1. Erst den Vertrag pruefen"));
        assert!(is_rule_like_statement("Regeln: immer freundlich"));
        assert!(is_rule_like_statement("Regel 1: gilt fuer alle"));
        assert!(!is_rule_like_statement("ohne die Regel geht es nicht"));
        assert!(!is_rule_like_statement(""));
        assert!(!is_rule_like_statement("Die Sauna war warm"));
    }

    #[test]
    fn numbered_fragments_win_over_the_sentence_fallback() {
        let text = "Regeln: 1. Immer hoeflich sein 2. Nicht unterbrechen";
        let fragments = extract_rule_fragments(text, 6);
        assert_eq!(
            fragments,
            vec![
                "1. Immer hoeflich sein".to_string(),
                "2. Nicht unterbrechen".to_string(),
            ]
        );
        assert_eq!(extract_rule_fragments("", 6), Vec::<String>::new());
    }

    #[test]
    fn the_sentence_fallback_keeps_rule_like_sentences_only() {
        let text = "Die Sauna war warm. Regel eins gilt fuer alle. Abschnitt 2: bitte beachten";
        let fragments = extract_rule_fragments(text, 6);
        assert!(fragments
            .iter()
            .any(|entry| entry.starts_with("Regel eins gilt fuer alle")));
        assert!(!fragments.iter().any(|entry| entry.contains("Sauna")));
    }

    #[test]
    fn the_number_is_capped_at_max_fragments() {
        let text = "1. aa bb 2. cc dd 3. ee ff";
        assert_eq!(extract_rule_fragments(text, 2).len(), 2);
    }
}
