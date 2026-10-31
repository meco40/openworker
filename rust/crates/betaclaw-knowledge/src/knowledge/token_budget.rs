//! Port of `src/server/knowledge/tokenBudget.ts` (1-49).
//!
//! | TypeScript                                   | Rust |
//! | -------------------------------------------- | ---- |
//! | `tokenBudget.ts:1-5` (`estimateTokenCount`)   | [`estimate_token_count`] |
//! | `tokenBudget.ts:7-27` (`trimToTokenBudget`)   | [`trim_to_token_budget`] |
//! | `tokenBudget.ts:29-49` (`enforceSectionBudgets`) | [`enforce_section_budgets`] |
//!
//! The consumed input is a JavaScript `number`: `estimateTokenCount` returns a
//! `number`, `maxTokens` is a `number` and `Math.floor`/`Math.ceil`/`Math.max`
//! are applied to it. The port therefore keeps `f64` for the token arithmetic
//! and only converts where a stored integer is demanded (the retrieval audit's
//! `token_count`).
//!
//! This file is a dependency of the retrieval package
//! (`formatters/budgetCalculator.ts:1-5`); it lives at the knowledge root
//! because that is where its TypeScript original lives.
//!
//! # Deviations
//!
//! 1. **`enforceSectionBudgets` is not generic.** The TypeScript is
//!    `enforceSectionBudgets<T extends Record<string, string>>` and iterates
//!    `Object.keys(sections)`. The only call site (`budgetCalculator.ts:52-57`)
//!    passes the four knowledge sections and a weight record with exactly those
//!    four keys, so [`enforce_section_budgets`] fixes that key set in
//!    [`crate::knowledge::retrieval::types::KnowledgeRetrievalSections`] and
//!    [`SectionWeights`]. The iteration order is the object-literal order of
//!    `budgetCalculator.ts:53-56`.
//! 2. **Character cutting happens on char boundaries.** `trimToTokenBudget`
//!    ends with `trimmed.slice(0, -1).trimEnd()`, which removes one UTF-16 code
//!    unit; the port removes one `char`. For a string ending in an astral
//!    character the TypeScript would slice a surrogate pair in half, which is
//!    not representable as UTF-8 text. Every input of this function is a
//!    retrieval section assembled from stored text.
//! 3. **Whitespace set.** JavaScript `\s`/`String#trim` and Rust's
//!    `White_Space` differ in exactly one code point: `U+0085` (NEL) is
//!    whitespace for Rust but not for JavaScript. No ported statement produces
//!    that character.
//!
//! `Buffer.byteLength(String(text || ''), 'utf8')` (`tokenBudget.ts:2`) is
//! `text.len()` for a Rust `&str`: both count the UTF-8 bytes, and a `String`
//! never holds `null`/`undefined`.

use crate::knowledge::retrieval::types::{KnowledgeRetrievalSections, SECTION_KEYS};

/// `estimateTokenCount` from `tokenBudget.ts:1-5`.
///
/// Four bytes per token, rounded up, at least one token for any non-empty
/// input. The empty string has no bytes and yields `0`.
pub fn estimate_token_count(text: &str) -> f64 {
    let bytes = text.len() as f64;
    if bytes <= 0.0 {
        return 0.0;
    }
    (bytes / 4.0).ceil().max(1.0)
}

/// `trimToTokenBudget` from `tokenBudget.ts:7-27`.
///
/// Words are appended while the running text still fits; the trailing
/// character-per-character loop is the second guard of the source and is kept
/// as is (with a fitting word list it cannot shorten anything further).
pub fn trim_to_token_budget(text: &str, max_tokens: f64) -> String {
    let normalized = text.trim();
    if normalized.is_empty() {
        return String::new();
    }
    if max_tokens <= 0.0 {
        return String::new();
    }

    let words: Vec<&str> = normalized
        .split_whitespace()
        .filter(|word| !word.is_empty())
        .collect();
    let mut output: Vec<&str> = Vec::new();

    for word in words {
        let next = if output.is_empty() {
            word.to_string()
        } else {
            format!("{} {}", output.join(" "), word)
        };
        if estimate_token_count(&next) > max_tokens {
            break;
        }
        output.push(word);
    }

    let mut trimmed = output.join(" ");
    while !trimmed.is_empty() && estimate_token_count(&trimmed) > max_tokens {
        trimmed.pop();
        trimmed = trimmed.trim_end().to_string();
    }

    trimmed
}

/// `Record<keyof T, number>` of `enforceSectionBudgets` (`tokenBudget.ts:32`).
///
/// `budgetCalculator.ts:52-57` hands over
/// `{ answerDraft: 0.4, keyDecisions: 0.25, openPoints: 0.15, evidence: 0.2 }`.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct SectionWeights {
    pub answer_draft: f64,
    pub key_decisions: f64,
    pub open_points: f64,
    pub evidence: f64,
}

impl SectionWeights {
    /// `weights[key]` in the key order of [`SECTION_KEYS`].
    fn at(&self, index: usize) -> f64 {
        match index {
            0 => self.answer_draft,
            1 => self.key_decisions,
            2 => self.open_points,
            _ => self.evidence,
        }
    }
}

/// `enforceSectionBudgets` from `tokenBudget.ts:29-49`.
///
/// `Math.max(0, Number(weights[key] || 0))` is per key; a weight total of `0`
/// (or less) is replaced by `1`, so every section still gets its one-token
/// floor.
pub fn enforce_section_budgets(
    sections: &KnowledgeRetrievalSections,
    max_tokens: f64,
    weights: &SectionWeights,
) -> KnowledgeRetrievalSections {
    let normalized_max = max_tokens.floor().max(1.0);

    let mut total_weight = 0.0;
    for index in 0..SECTION_KEYS.len() {
        total_weight += weights.at(index).max(0.0);
    }
    if total_weight <= 0.0 {
        total_weight = 1.0;
    }

    let mut output = sections.clone();
    for (index, key) in SECTION_KEYS.iter().enumerate() {
        let section_weight = weights.at(index).max(0.0);
        let budget = ((normalized_max * section_weight) / total_weight)
            .floor()
            .max(1.0);
        let trimmed = trim_to_token_budget(sections.get(key), budget);
        output.set(key, trimmed);
    }

    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::knowledge::retrieval::types::SECTION_KEYS;

    #[test]
    fn an_empty_text_has_no_tokens_and_any_other_text_has_at_least_one() {
        assert_eq!(estimate_token_count(""), 0.0);
        assert_eq!(estimate_token_count("a"), 1.0);
        assert_eq!(estimate_token_count("abcd"), 1.0);
        assert_eq!(estimate_token_count("abcde"), 2.0);
        // Bytes, not characters: "ä" is two UTF-8 bytes.
        assert_eq!(estimate_token_count("ä"), 1.0);
        // Five umlauts are ten UTF-8 bytes -> ceil(2.5) = 3 tokens.
        assert_eq!(estimate_token_count("äöüüü"), 3.0);
    }

    #[test]
    fn trimming_keeps_the_words_that_fit_and_drops_the_rest() {
        // Four bytes per token: "aaaa bbbb" is 9 bytes -> 3 tokens.
        assert_eq!(trim_to_token_budget("aaaa bbbb", 3.0), "aaaa bbbb");
        assert_eq!(trim_to_token_budget("aaaa bbbb", 2.0), "aaaa");
        assert_eq!(trim_to_token_budget("  aaaa   bbbb  ", 2.0), "aaaa");
        assert_eq!(trim_to_token_budget("aaaa", 0.0), "");
        assert_eq!(trim_to_token_budget("", 10.0), "");
    }

    #[test]
    fn a_word_that_does_not_fit_is_dropped_entirely() {
        // "aaaaaaaaaa aaaa" is 15 bytes; a budget of 2 tokens is 8 bytes, so
        // even the first word (10 bytes -> 3 tokens) is over budget and the
        // result is empty — the source breaks before pushing it.
        assert_eq!(trim_to_token_budget("aaaaaaaaaa aaaa", 2.0), "");
        // With 3 tokens (12 bytes) the first word fits, the second does not.
        assert_eq!(trim_to_token_budget("aaaaaaaaaa aaaa", 3.0), "aaaaaaaaaa");
    }

    #[test]
    fn section_budgets_follow_the_weight_ratios() {
        // 100 one-character words per section: 199 bytes -> 50 tokens each.
        let sections = KnowledgeRetrievalSections {
            answer_draft: vec!["a"; 100].join(" "),
            key_decisions: vec!["k"; 100].join(" "),
            open_points: vec!["o"; 100].join(" "),
            evidence: vec!["e"; 100].join(" "),
        };
        let weights = SectionWeights {
            answer_draft: 0.4,
            key_decisions: 0.25,
            open_points: 0.15,
            evidence: 0.2,
        };
        let words = |value: &str| value.split(' ').count();

        // 100 tokens: 40/25/15/20 per section = 160/100/60/80 bytes, i.e. the
        // words that still fit: 80/50/30/40 one-character words.
        let hundred = enforce_section_budgets(&sections, 100.0, &weights);
        assert_eq!(words(&hundred.answer_draft), 80);
        assert_eq!(words(&hundred.key_decisions), 50);
        assert_eq!(words(&hundred.open_points), 30);
        assert_eq!(words(&hundred.evidence), 40);

        // 50 tokens: 20/12/7/10 per section = 80/48/28/40 bytes -> 40/24/14/20.
        let fifty = enforce_section_budgets(&sections, 50.0, &weights);
        assert_eq!(words(&fifty.answer_draft), 40);
        assert_eq!(words(&fifty.key_decisions), 24);
        assert_eq!(words(&fifty.open_points), 14);
        assert_eq!(words(&fifty.evidence), 20);

        // A section that already fits its budget stays verbatim.
        let short = KnowledgeRetrievalSections {
            answer_draft: "kurz".to_string(),
            ..KnowledgeRetrievalSections::default()
        };
        assert_eq!(
            enforce_section_budgets(&short, 100.0, &weights).answer_draft,
            "kurz"
        );
    }

    #[test]
    fn a_zero_weight_total_falls_back_to_one_and_every_section_keeps_a_floor() {
        let sections = KnowledgeRetrievalSections {
            answer_draft: "aa".to_string(),
            key_decisions: String::new(),
            open_points: "cc".to_string(),
            evidence: String::new(),
        };
        let zero = SectionWeights::default();
        let budgeted = enforce_section_budgets(&sections, 0.0, &zero);
        // normalizedMax = 1, totalWeight = 1, budget = 1 token = 4 bytes.
        assert_eq!(budgeted.answer_draft, "aa");
        assert_eq!(budgeted.open_points, "cc");
        assert_eq!(budgeted.evidence, "");
        assert_eq!(SECTION_KEYS.len(), 4);
    }
}
