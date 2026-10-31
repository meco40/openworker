//! Port of `src/server/knowledge/correctionDetector.ts` (1-57).
//!
//! | TypeScript                                       | Rust |
//! | ------------------------------------------------ | ---- |
//! | `correctionDetector.ts:8-14` (`CorrectionResult`) | [`CorrectionResult`] |
//! | `correctionDetector.ts:16-22` (`CORRECTION_SIGNALS`) | [`correction_signals`] |
//! | `correctionDetector.ts:27-37` (`extractOldNewPair`) | [`extract_old_new_pair`] |
//! | `correctionDetector.ts:42-57` (`detectCorrection`) | [`detect_correction`] |
//!
//! Pure function, no service dependency. Dependency of `ingestion/service.ts`
//! (S6-owned).
//!
//! # JavaScript semantics that are reproduced explicitly
//!
//! * `.` does not match a line terminator in JavaScript and the Rust `regex`
//!   crate agrees by default, so `nein … sondern` stays on one line.
//! * `CORRECTION_SIGNALS.some(...)` is a short-circuit over declaration order;
//!   the outcome is order-independent, the port keeps the order anyway.
//! * JavaScript's `\w` is ASCII; the class below spells `[0-9A-Za-z_]` out.
//! * The extracted pair is **not** lowercased (`:33`) — the port returns it as
//!   written.
//!
//! # Deviation
//!
//! `CorrectionResult.targetFact` is declared (`:13`) but no code path ever sets
//! it, so every TypeScript result carries `undefined`. The port keeps the field
//! and always returns [`None`], which is the observable behaviour.
//!
//! # Regex justification
//!
//! The signals need `\b`, bounded gaps and non-capturing groups (`:16-22`,
//! `:29-31`), which `regex` — the crate the workspace already depends on for
//! these patterns — covers directly.

use regex::Regex;
use std::sync::OnceLock;

/// `CorrectionResult.correctionType` (`correctionDetector.ts:12`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CorrectionType {
    NameChange,
    ValueChange,
    FactReversal,
    None,
}

impl CorrectionType {
    /// The TypeScript union member, verbatim.
    pub fn as_str(self) -> &'static str {
        match self {
            CorrectionType::NameChange => "name_change",
            CorrectionType::ValueChange => "value_change",
            CorrectionType::FactReversal => "fact_reversal",
            CorrectionType::None => "none",
        }
    }
}

/// `CorrectionResult` (`correctionDetector.ts:8-14`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CorrectionResult {
    pub is_correction: bool,
    pub old_value: Option<String>,
    pub new_value: Option<String>,
    pub correction_type: CorrectionType,
    /// Always [`None`]; see the module header.
    pub target_fact: Option<String>,
}

/// `CORRECTION_SIGNALS` (`correctionDetector.ts:16-22`).
pub fn correction_signals() -> &'static [Regex] {
    static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        vec![
            Regex::new(r"(?i)\bnein\b.{0,30}\bsondern\b").expect("correction signal"),
            Regex::new(r"(?i)\bnicht\b.{0,30}\bsondern\b").expect("correction signal"),
            Regex::new(r"(?i)\bfalsch\b").expect("correction signal"),
            Regex::new(r"(?i)\bstimmt\s+nicht").expect("correction signal"),
            Regex::new(r"(?i)\b(?:korrektur|richtigstellung|berichtigung)\s*:")
                .expect("correction signal"),
        ]
    })
}

/// `/nicht\s+(?:den|der|die|das|dem)?\s*(\w+)\s*,?\s*sondern\s+(?:den|der|die|das|dem)?\s*(\w+)/i`
/// (`correctionDetector.ts:29-31`). The `\b`s of the source are kept.
fn old_new_pair_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(
            r"(?i)\bnicht\b\s+(?:den|der|die|das|dem)?\s*([0-9A-Za-z_]+)\s*,?\s*sondern\s+(?:den|der|die|das|dem)?\s*([0-9A-Za-z_]+)",
        )
        .expect("old/new pair pattern")
    })
}

/// `extractOldNewPair(text)` (`correctionDetector.ts:27-37`).
pub fn extract_old_new_pair(text: &str) -> Option<(String, String)> {
    let captures = old_new_pair_pattern().captures(text)?;
    let old_value = captures.get(1)?;
    let new_value = captures.get(2)?;
    Some((
        old_value.as_str().to_string(),
        new_value.as_str().to_string(),
    ))
}

/// `detectCorrection(text)` (`correctionDetector.ts:42-57`).
pub fn detect_correction(text: &str) -> CorrectionResult {
    let is_correction = correction_signals()
        .iter()
        .any(|pattern| pattern.is_match(text));

    if !is_correction {
        return CorrectionResult {
            is_correction: false,
            old_value: None,
            new_value: None,
            correction_type: CorrectionType::None,
            target_fact: None,
        };
    }

    match extract_old_new_pair(text) {
        Some((old_value, new_value)) => CorrectionResult {
            is_correction: true,
            old_value: Some(old_value),
            new_value: Some(new_value),
            correction_type: CorrectionType::ValueChange,
            target_fact: None,
        },
        None => CorrectionResult {
            is_correction: true,
            old_value: None,
            new_value: None,
            correction_type: CorrectionType::FactReversal,
            target_fact: None,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_nicht_sondern_pair_is_a_value_change() {
        let result = detect_correction("Nein, das war nicht Lisa, sondern Maria");
        assert!(result.is_correction);
        assert_eq!(result.correction_type, CorrectionType::ValueChange);
        assert_eq!(result.old_value.as_deref(), Some("Lisa"));
        assert_eq!(result.new_value.as_deref(), Some("Maria"));
        assert_eq!(result.target_fact, None);
    }

    #[test]
    fn an_article_between_nicht_and_the_name_is_skipped() {
        let pair = extract_old_new_pair("das war nicht der Paul sondern der Max").expect("pair");
        assert_eq!(pair.0, "Paul");
        assert_eq!(pair.1, "Max");
    }

    #[test]
    fn the_pair_keeps_its_capitalisation_and_cuts_at_a_non_ascii_letter() {
        let pair = extract_old_new_pair("nicht Anna sondern Björn").expect("pair");
        assert_eq!(pair.0, "Anna");
        // JavaScript's `\w` is ASCII-only, so the capture stops before `ö`;
        // the port reproduces that cut instead of widening the class.
        assert_eq!(pair.1, "Bj");
    }

    #[test]
    fn a_signal_without_a_pair_is_a_fact_reversal() {
        for text in [
            "das ist falsch",
            "das stimmt nicht",
            "Korrektur: es war Montag",
        ] {
            let result = detect_correction(text);
            assert!(result.is_correction, "{text}");
            assert_eq!(
                result.correction_type,
                CorrectionType::FactReversal,
                "{text}"
            );
            assert_eq!(result.old_value, None, "{text}");
            assert_eq!(result.new_value, None, "{text}");
        }
    }

    #[test]
    fn plain_text_is_not_a_correction() {
        let result = detect_correction("Nata hat einen Bruder namens Max");
        assert!(!result.is_correction);
        assert_eq!(result.correction_type, CorrectionType::None);
        assert_eq!(result.old_value, None);
        assert_eq!(result.new_value, None);
    }

    #[test]
    fn the_gap_between_the_signals_is_bounded_to_thirty_characters() {
        // Node 24 confirms: 28 filler characters still match, 29 do not. The
        // gap the regex measures is `" " + filler + " "`.
        let within = format!("nein {} sondern doch", "x".repeat(28));
        assert!(correction_signals()[0].is_match(&within));
        let beyond = format!("nein {} sondern doch", "x".repeat(29));
        assert!(!correction_signals()[0].is_match(&beyond));
    }
}
