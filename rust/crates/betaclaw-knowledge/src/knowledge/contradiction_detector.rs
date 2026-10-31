//! Port of `src/server/knowledge/contradictionDetector.ts` (1-156).
//!
//! | TypeScript                                          | Rust |
//! | --------------------------------------------------- | ---- |
//! | `contradictionDetector.ts:8` (`ContradictionType`)   | [`ContradictionType`] |
//! | `contradictionDetector.ts:10-14` (`ContradictionSignal`) | [`ContradictionSignal`] |
//! | `contradictionDetector.ts:22-29` (`SLOT_PATTERNS`)   | [`slot_patterns`] |
//! | `contradictionDetector.ts:31-32` (`NEGATION_WORDS*`) | [`negation_words`] |
//! | `contradictionDetector.ts:37-46` (`extractSubject`)  | [`extract_subject`] |
//! | `contradictionDetector.ts:51-59` (`extractSlot`)     | [`extract_slot`] |
//! | `contradictionDetector.ts:65-107` (`detectNegation`) | [`detect_negation`] |
//! | `contradictionDetector.ts:115-156` (`detectContradictionSignal`) | [`detect_contradiction_signal`] |
//!
//! Pure signal detection, no service dependency. Dependency of
//! `ingestion/service.ts` (S6-owned).
//!
//! # JavaScript semantics that are reproduced explicitly
//!
//! * JavaScript's `\w` is ASCII (`[A-Za-z0-9_]`) while the Rust `regex` crate's
//!   `\w` is Unicode. Every pattern below therefore spells the ASCII class out,
//!   so `extractSubject` and `extractSlot` cut at the same character as the
//!   source. `\p{L}`/`\p{N}` stay Unicode, as the source spells them that way.
//! * `SLOT_PATTERNS` is walked in declaration order and the first match wins
//!   (`:52-57`).
//! * `overlap / Math.max(a, b)` and `>= 0.5` keep the IEEE-754 comparison;
//!   `Math.max` of two lengths is the same integer maximum.
//! * `new Set(...)` drops duplicate words; the port intersects two `HashSet`s,
//!   so only the sizes and the shared words matter, never the iteration order.
//! * An empty word set returns `false` *before* the division
//!   (`contradictionDetector.ts:98`), so no `0/0 = NaN` branch is reachable.
//!
//! # Regex justification
//!
//! The slot patterns need capture groups, alternation and word boundaries
//! (`:22-32`); the negation-stripping pass needs `\p{L}`, `\p{N}` and `\s`
//! (`:76-78`). Both are covered by the `regex` dependency the workspace already
//! carries for exactly this class of pattern.

use regex::Regex;
use std::collections::HashSet;
use std::sync::OnceLock;

/// `ContradictionType` (`contradictionDetector.ts:8`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContradictionType {
    DirectOverride,
    ValueChange,
    Negation,
    None,
}

impl ContradictionType {
    /// The TypeScript union member, verbatim.
    pub fn as_str(self) -> &'static str {
        match self {
            ContradictionType::DirectOverride => "direct_override",
            ContradictionType::ValueChange => "value_change",
            ContradictionType::Negation => "negation",
            ContradictionType::None => "none",
        }
    }
}

/// `ContradictionSignal` (`contradictionDetector.ts:10-14`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ContradictionSignal {
    pub has_contradiction: bool,
    pub contradiction_type: ContradictionType,
    pub confidence: f64,
}

/// `SLOT_PATTERNS` (`contradictionDetector.ts:22-29`), in declaration order.
pub fn slot_patterns() -> &'static [(Regex, &'static str)] {
    static PATTERNS: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        vec![
            (
                Regex::new(r"(?i)\bist\s+mein[e]?\s+([0-9A-Za-z_]+)").expect("slot pattern"),
                "relationship",
            ),
            (
                Regex::new(r"(?i)\barbeite\s+bei\s+([0-9A-Za-z_]+)").expect("slot pattern"),
                "employer",
            ),
            (
                Regex::new(r"(?i)\bwohne\s+in\s+([0-9A-Za-z_]+)").expect("slot pattern"),
                "location",
            ),
            (
                Regex::new(r"(?i)\bbin\s+(\d+)\s+jahre").expect("slot pattern"),
                "age",
            ),
            (
                Regex::new(r"(?i)\bheisse\s+([0-9A-Za-z_]+)").expect("slot pattern"),
                "name",
            ),
            (
                Regex::new(r"(?i)\bstudiere\s+([0-9A-Za-z_]+)").expect("slot pattern"),
                "study",
            ),
        ]
    })
}

/// `NEGATION_WORDS` / `NEGATION_WORDS_GLOBAL` (`contradictionDetector.ts:31-32`).
/// Rust's `replace_all` is already global, so one pattern covers both.
fn negation_words() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"(?i)\b(nicht|kein|keine|keinen|keinem|nie|niemals|never)\b")
            .expect("negation pattern")
    })
}

/// `/^([A-ZÄÖÜ]\w+)\b/` (`contradictionDetector.ts:39`) — deliberately **not**
/// case-insensitive.
fn subject_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r"^([A-ZÄÖÜ][0-9A-Za-z_]+)\b").expect("subject pattern"))
}

/// `/^ich\b/i` (`contradictionDetector.ts:43`).
fn ich_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r"(?i)^ich\b").expect("subject pattern"))
}

/// The slot of a fact: `{ slotName, value }` (`contradictionDetector.ts:51-59`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SlotValue {
    pub slot_name: &'static str,
    pub value: String,
}

/// `extractSubject(text)` (`contradictionDetector.ts:37-46`).
pub fn extract_subject(text: &str) -> Option<String> {
    let trimmed = text.trim();
    if let Some(captures) = subject_pattern().captures(trimmed) {
        if let Some(name) = captures.get(1) {
            return Some(name.as_str().to_lowercase());
        }
    }
    if ich_pattern().is_match(trimmed) {
        return Some("ich".to_string());
    }
    None
}

/// `extractSlot(text)` (`contradictionDetector.ts:51-59`).
pub fn extract_slot(text: &str) -> Option<SlotValue> {
    for (pattern, slot_name) in slot_patterns() {
        if let Some(captures) = pattern.captures(text) {
            if let Some(value) = captures.get(1) {
                return Some(SlotValue {
                    slot_name,
                    value: value.as_str().to_lowercase(),
                });
            }
        }
    }
    None
}

/// `detectNegation(newFact, existingFact)` (`contradictionDetector.ts:65-107`).
pub fn detect_negation(new_fact: &str, existing_fact: &str) -> bool {
    let new_has_negation = negation_words().is_match(new_fact);
    let existing_has_negation = negation_words().is_match(existing_fact);
    if new_has_negation == existing_has_negation {
        return false;
    }

    let new_words = significant_words(&strip_negation(new_fact));
    let existing_words = significant_words(&strip_negation(existing_fact));
    if new_words.is_empty() || existing_words.is_empty() {
        return false;
    }

    let overlap = new_words.intersection(&existing_words).count();
    let overlap_ratio = overlap as f64 / new_words.len().max(existing_words.len()) as f64;
    overlap_ratio >= 0.5
}

/// `stripNeg` (`contradictionDetector.ts:73-79`).
fn strip_negation(text: &str) -> String {
    static NON_WORD: OnceLock<Regex> = OnceLock::new();
    static WHITESPACE: OnceLock<Regex> = OnceLock::new();
    let non_word =
        NON_WORD.get_or_init(|| Regex::new(r"[^\p{L}\p{N}\s]").expect("non-word pattern"));
    let whitespace = WHITESPACE.get_or_init(|| Regex::new(r"\s+").expect("whitespace pattern"));

    let without_negation = negation_words().replace_all(text, " ");
    let without_punctuation = non_word.replace_all(&without_negation, " ");
    whitespace
        .replace_all(&without_punctuation, " ")
        .trim()
        .to_lowercase()
}

/// The `new Set(...split(' ')...filter(w => w.length > 2))` step
/// (`contradictionDetector.ts:85-96`).
fn significant_words(text: &str) -> HashSet<String> {
    text.split(' ')
        .map(str::trim)
        .filter(|word| word.chars().count() > 2)
        .map(str::to_string)
        .collect()
}

/// `detectContradictionSignal(newFact, existingFact)` (`contradictionDetector.ts:115-156`).
pub fn detect_contradiction_signal(new_fact: &str, existing_fact: &str) -> ContradictionSignal {
    if detect_negation(new_fact, existing_fact) {
        return ContradictionSignal {
            has_contradiction: true,
            contradiction_type: ContradictionType::Negation,
            confidence: 0.85,
        };
    }

    let new_slot = extract_slot(new_fact);
    let existing_slot = extract_slot(existing_fact);
    if let (Some(new_subject), Some(existing_subject), Some(new_slot), Some(existing_slot)) = (
        extract_subject(new_fact),
        extract_subject(existing_fact),
        new_slot,
        existing_slot,
    ) {
        if new_subject == existing_subject
            && new_slot.slot_name == existing_slot.slot_name
            && new_slot.value != existing_slot.value
        {
            let contradiction_type = if new_slot.slot_name == "relationship" {
                ContradictionType::ValueChange
            } else {
                ContradictionType::DirectOverride
            };
            return ContradictionSignal {
                has_contradiction: true,
                contradiction_type,
                confidence: 0.8,
            };
        }
    }

    ContradictionSignal {
        has_contradiction: false,
        contradiction_type: ContradictionType::None,
        confidence: 0.1,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn signal(new_fact: &str, existing_fact: &str) -> ContradictionSignal {
        detect_contradiction_signal(new_fact, existing_fact)
    }

    #[test]
    fn a_negation_against_a_positive_statement_is_a_negation_signal() {
        let result = signal("Max hat keine Freundin", "Max hat eine Freundin");
        assert!(result.has_contradiction);
        assert_eq!(result.contradiction_type, ContradictionType::Negation);
        assert_eq!(result.confidence, 0.85);
    }

    #[test]
    fn two_facts_with_the_same_polarity_are_not_a_negation() {
        assert!(!detect_negation(
            "Max hat keine Freundin",
            "Max hat keinen Bruder"
        ));
        assert!(!detect_negation(
            "Max hat eine Freundin",
            "Max hat einen Bruder"
        ));
        // No shared content after stripping — the ratio stays below 0.5.
        assert!(!detect_negation(
            "Max hat keine Freundin",
            "Nata hat eine Schwester"
        ));
    }

    #[test]
    fn the_subject_is_the_first_capitalised_word_or_ich() {
        assert_eq!(
            extract_subject("Nata ist traurig"),
            Some("nata".to_string())
        );
        assert_eq!(
            extract_subject("  ich wohne in Berlin"),
            Some("ich".to_string())
        );
        assert_eq!(
            extract_subject("Ich wohne in Berlin"),
            Some("ich".to_string())
        );
        assert_eq!(extract_subject("der Bruder ist krank"), None);
        // One letter is not enough: `[A-ZÄÖÜ]\w+` needs at least two characters.
        assert_eq!(extract_subject("A"), None);
    }

    #[test]
    fn the_first_matching_slot_pattern_wins() {
        let slot = extract_slot("Nata ist meine Schwester").expect("slot");
        assert_eq!(slot.slot_name, "relationship");
        assert_eq!(slot.value, "schwester");

        let slot = extract_slot("Ich arbeite bei Acme").expect("slot");
        assert_eq!(slot.slot_name, "employer");
        assert_eq!(slot.value, "acme");

        let slot = extract_slot("Ich bin 30 Jahre alt").expect("slot");
        assert_eq!(slot.slot_name, "age");
        assert_eq!(slot.value, "30");

        assert_eq!(extract_slot("Nata mag Kaffee"), None);
    }

    #[test]
    fn the_same_relationship_slot_with_a_new_value_is_a_value_change() {
        let result = signal("Nata ist meine Schwester", "Nata ist mein Bruder");
        assert!(result.has_contradiction);
        assert_eq!(result.contradiction_type, ContradictionType::ValueChange);
        assert_eq!(result.confidence, 0.8);
    }

    #[test]
    fn every_other_slot_is_a_direct_override() {
        let employer = signal("Ich arbeite bei Globex", "Ich arbeite bei Acme");
        assert_eq!(
            employer.contradiction_type,
            ContradictionType::DirectOverride
        );
        assert!(employer.has_contradiction);

        let age = signal("Ich bin 31 Jahre alt", "Ich bin 30 Jahre alt");
        assert_eq!(age.contradiction_type, ContradictionType::DirectOverride);
        assert!(age.has_contradiction);
    }

    #[test]
    fn different_subjects_never_contradict() {
        let result = signal("Nata ist meine Schwester", "Max ist mein Bruder");
        assert!(!result.has_contradiction);
        assert_eq!(result.contradiction_type, ContradictionType::None);
        assert_eq!(result.confidence, 0.1);
    }

    #[test]
    fn the_same_slot_with_the_same_value_is_not_a_contradiction() {
        let result = signal("Nata ist mein Bruder", "Nata ist mein Bruder");
        assert!(!result.has_contradiction);
        assert_eq!(result.contradiction_type, ContradictionType::None);
    }
}
