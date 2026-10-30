//! Port of `src/server/knowledge/retrieval/service/query/rules.ts` (1-40).
//!
//! | TypeScript                                          | Rust |
//! | --------------------------------------------------- | ---- |
//! | `service/query/rules.ts:7-23` (`hasMeaningfulOverlap`) | [`has_meaningful_overlap`] |
//! | `service/query/rules.ts:25-29` (`hasValidSourceRefs`)  | [`has_valid_source_refs`] |
//! | `service/query/rules.ts:31-37` (`hasRuleLikeFragments`)| [`has_rule_like_fragments`] |
//!
//! `isRuleLikeStatement` and `extractRuleFragments` are re-exported at `:40`;
//! the port keeps them where they are defined
//! ([`crate::knowledge::retrieval::query::rules_extractor`]) and re-exports them
//! from [`super::mod`].
//!
//! # Deviations
//!
//! 1. **`hasMeaningfulOverlap` counts whole tokens.** The source builds a `Set`
//!    of the left tokens and counts how many right tokens are in it; the port
//!    uses a [`BTreeSet`] with the same containment test.
//! 2. **`value.length` is UTF-16** through
//!    [`crate::knowledge::retrieval::js_str_len`].
//! 3. `refs || []` and `ref?.seq` collapse to an iterator over the slice
//!    (`Option<&[EvidenceSourceRef]>`).

use std::collections::BTreeSet;

use crate::knowledge::retrieval::formatters::evidence_builder::EvidenceSourceRef;
use crate::knowledge::retrieval::js_str_len;
pub use crate::knowledge::retrieval::query::rules_extractor::{
    extract_rule_fragments, is_rule_like_statement,
};

use super::parser::{normalize_rule_text, tokenize_rule_text};

/// `hasMeaningfulOverlap` from `service/query/rules.ts:7-23`.
pub fn has_meaningful_overlap(left: &str, right: &str) -> bool {
    let left_norm = normalize_rule_text(left);
    let right_norm = normalize_rule_text(right);
    if left_norm.is_empty() || right_norm.is_empty() {
        return false;
    }
    if left_norm.contains(&right_norm) || right_norm.contains(&left_norm) {
        return true;
    }

    let left_tokens: BTreeSet<String> = tokenize_rule_text(&left_norm).into_iter().collect();
    let right_tokens = tokenize_rule_text(&right_norm);
    if left_tokens.is_empty() || right_tokens.is_empty() {
        return false;
    }

    let overlap = right_tokens
        .iter()
        .filter(|token| left_tokens.contains(*token))
        .count();
    overlap >= 2
}

/// `hasValidSourceRefs` from `service/query/rules.ts:25-29` — the parameter is
/// structural (`Array<{ seq; quote }>`), so [`KnowledgeSourceRef`] and
/// [`EvidenceSourceRef`] both satisfy it through [`SourcedRef`].
pub trait SourcedRef {
    fn seq(&self) -> i64;
}

impl SourcedRef for crate::knowledge::repository::KnowledgeSourceRef {
    fn seq(&self) -> i64 {
        self.seq
    }
}

impl SourcedRef for EvidenceSourceRef {
    fn seq(&self) -> i64 {
        self.seq
    }
}

/// `hasValidSourceRefs` from `service/query/rules.ts:25-29`.
pub fn has_valid_source_refs<T: SourcedRef>(refs: Option<&[T]>) -> bool {
    refs.is_some_and(|refs| refs.iter().any(|reference| reference.seq() > 0))
}

/// `hasRuleLikeFragments` from `service/query/rules.ts:31-37`.
pub fn has_rule_like_fragments(values: &[String]) -> bool {
    let normalized: Vec<String> = values
        .iter()
        .map(|value| value.trim().to_string())
        .filter(|value| js_str_len(value) > 0)
        .collect();
    if normalized.iter().any(|value| is_rule_like_statement(value)) {
        return true;
    }
    !extract_rule_fragments(&normalized.join("\n"), 6).is_empty()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overlap_needs_two_shared_tokens_or_a_containment() {
        assert!(has_meaningful_overlap(
            "immer pruefen",
            "immer pruefen bitte"
        ));
        assert!(has_meaningful_overlap(
            "immer alles pruefen",
            "immer alles kontrollieren"
        ));
        assert!(!has_meaningful_overlap(
            "immer alles",
            "pruefen kontrollieren"
        ));
        assert!(!has_meaningful_overlap("", "x"));
    }

    #[test]
    fn only_positive_seqs_are_valid_refs() {
        let refs = vec![EvidenceSourceRef {
            seq: 2,
            quote: "x".into(),
        }];
        assert!(has_valid_source_refs(Some(&refs)));
        assert!(!has_valid_source_refs::<EvidenceSourceRef>(None));
        let zero = vec![EvidenceSourceRef {
            seq: 0,
            quote: "x".into(),
        }];
        assert!(!has_valid_source_refs(Some(&zero)));
    }

    #[test]
    fn a_rule_like_value_or_fragment_counts() {
        assert!(has_rule_like_fragments(&["1. immer pruefen".to_string()]));
        assert!(!has_rule_like_fragments(
            &["die sauna war warm".to_string()]
        ));
        assert!(!has_rule_like_fragments(&[]));
    }
}
