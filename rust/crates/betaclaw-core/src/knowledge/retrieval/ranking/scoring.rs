//! Port of `src/server/knowledge/retrieval/ranking/scoring.ts` (1-21).
//!
//! | TypeScript                                          | Rust |
//! | --------------------------------------------------- | ---- |
//! | `ranking/scoring.ts:3-12` (`computeTokenOverlapScore`) | [`compute_token_overlap_score`] |
//! | `ranking/scoring.ts:15-21` (`detectEmotionalToneInText`) | [`detect_emotional_tone_in_text`] |
//!
//! `computeTokenOverlapScore` counts the tokens that occur as a *substring* of
//! the normalized text (`String#includes`), not as whole words.
//!
//! `detectEmotionalToneInText` lowercases first and then matches a
//! case-sensitive pattern; `\b` is transcribed as `(?-u:\b)` for JavaScript's
//! ASCII word boundary (see `query/intent_detector.rs`).

use std::sync::OnceLock;

use regex::Regex;

use super::super::pattern;
use crate::knowledge::retrieval::query::intent_detector::normalize_lookup_text;

static EMOTION_KEYWORDS: OnceLock<Regex> = OnceLock::new();

/// `computeTokenOverlapScore` from `ranking/scoring.ts:3-12`.
pub fn compute_token_overlap_score(text: &str, tokens: &[String]) -> f64 {
    if tokens.is_empty() {
        return 0.0;
    }
    let normalized_text = normalize_lookup_text(text);
    if normalized_text.is_empty() {
        return 0.0;
    }
    let mut score = 0.0;
    for token in tokens {
        if normalized_text.contains(token.as_str()) {
            score += 1.0;
        }
    }
    score
}

/// `detectEmotionalToneInText` from `ranking/scoring.ts:15-21`.
///
/// Returns the first matching keyword, or [`None`] for `undefined`.
pub fn detect_emotional_tone_in_text(text: &str) -> Option<String> {
    let lowered = text.to_lowercase();
    let keywords = pattern(
        r"(?-u:\b)(traurig|wuetend|gluecklich|freude|streit|angst|liebe|verliebt|nervoes|besorgt|aufgeregt|enttaeuscht)(?-u:\b)",
        &EMOTION_KEYWORDS,
    );
    keywords
        .captures(&lowered)
        .and_then(|captures| captures.get(1).map(|value| value.as_str().to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overlap_counts_matching_tokens() {
        let tokens = vec!["vertrag".to_string(), "sauna".to_string()];
        assert_eq!(
            compute_token_overlap_score("Der Vertrag und die Sauna", &tokens),
            2.0
        );
        assert_eq!(compute_token_overlap_score("nur der Vertrag", &tokens), 1.0);
        assert_eq!(compute_token_overlap_score("", &tokens), 0.0);
        assert_eq!(compute_token_overlap_score("egal", &[]), 0.0);
    }

    #[test]
    fn the_tone_is_the_first_matching_keyword_or_none() {
        assert_eq!(
            detect_emotional_tone_in_text("Wir hatten Streit und Angst"),
            Some("streit".to_string())
        );
        assert_eq!(detect_emotional_tone_in_text("Alles ruhig"), None);
        // Lowercasing happens before the match.
        assert_eq!(
            detect_emotional_tone_in_text("TRAURIG"),
            Some("traurig".to_string())
        );
    }
}
