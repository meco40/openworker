//! Port of `src/server/world-model/consolidation/policy.ts:1-18`.
//!
//! # Two JavaScript details that decide the result
//!
//! * `summary.length` (`policy.ts:13`) counts **UTF-16 code units**, not scalar
//!   values: a 12 001-character emoji is `24 002` for JavaScript. The port counts
//!   `encode_utf16().count()` so the 12 000 boundary lands on the same strings as
//!   the TypeScript.
//! * `[...new Set(ids)].sort()` (`policy.ts:20`) sorts with the default
//!   comparator, which compares UTF-16 code units. The port sorts the trimmed
//!   strings byte-wise, which is the same order for the whole Basic Multilingual
//!   Plane and differs only for surrogate pairs. Unlike the TypeScript, the port
//!   cannot silently collapse a lone surrogate, because Rust strings are valid
//!   UTF-8.

/// `CONSOLIDATION_POLICY_VERSION` from `policy.ts:1`.
pub const CONSOLIDATION_POLICY_VERSION: &str = "1";

/// `ConsolidationPolicyInput` from `policy.ts:3-6`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ConsolidationPolicyInput {
    pub summary: String,
    pub source_observation_ids: Vec<String>,
}

/// `validateConsolidationPolicy` (`policy.ts:8-17`).
///
/// The messages are the four literals of the source, in the same order.
pub fn validate_consolidation_policy(input: &ConsolidationPolicyInput) -> Vec<String> {
    let mut errors = Vec::new();
    let summary = input.summary.trim();
    let sources = normalized_source_observation_ids(&input.source_observation_ids);
    if summary.is_empty() {
        errors.push("summary must not be empty".to_string());
    }
    if summary.encode_utf16().count() > 12_000 {
        errors.push("summary exceeds 12000 characters".to_string());
    }
    if sources.is_empty() {
        errors.push("at least one source observation is required".to_string());
    }
    if sources.len() > 100 {
        errors.push("at most 100 source observations are allowed".to_string());
    }
    errors
}

/// `normalizedSourceObservationIds` (`policy.ts:19-21`).
///
/// `new Set` keeps the first occurrence, so the sort is applied to a
/// de-duplicated list; the port keeps the same two steps in the same order.
pub fn normalized_source_observation_ids(ids: &[String]) -> Vec<String> {
    let mut seen: Vec<String> = Vec::new();
    for id in ids {
        let trimmed = id.trim();
        if trimmed.is_empty() {
            continue;
        }
        if !seen.iter().any(|existing| existing == trimmed) {
            seen.push(trimmed.to_string());
        }
    }
    seen.sort();
    seen
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(summary: &str, ids: &[&str]) -> ConsolidationPolicyInput {
        ConsolidationPolicyInput {
            summary: summary.to_string(),
            source_observation_ids: ids.iter().map(|id| id.to_string()).collect(),
        }
    }

    #[test]
    fn a_valid_input_reports_nothing() {
        assert!(validate_consolidation_policy(&input("summary", &["o1"])).is_empty());
    }

    #[test]
    fn empty_summary_and_no_sources_are_reported_in_source_order() {
        assert_eq!(
            validate_consolidation_policy(&input("   ", &[])),
            vec![
                "summary must not be empty".to_string(),
                "at least one source observation is required".to_string()
            ]
        );
    }

    #[test]
    fn the_summary_limit_counts_utf16_code_units() {
        let ok = "a".repeat(12_000);
        assert!(validate_consolidation_policy(&input(&ok, &["o1"])).is_empty());
        let too_long = "a".repeat(12_001);
        assert_eq!(
            validate_consolidation_policy(&input(&too_long, &["o1"])),
            vec!["summary exceeds 12000 characters".to_string()]
        );
        // One astral character is two UTF-16 code units, so 6 001 of them are
        // already over the limit although the string has 6 001 scalar values.
        let astral = "\u{1F600}".repeat(6_001);
        assert_eq!(
            validate_consolidation_policy(&input(&astral, &["o1"])),
            vec!["summary exceeds 12000 characters".to_string()]
        );
    }

    #[test]
    fn the_source_limit_is_checked_after_normalization() {
        let ids: Vec<String> = (0..101).map(|index| format!("o{index:03}")).collect();
        let errors = validate_consolidation_policy(&ConsolidationPolicyInput {
            summary: "s".to_string(),
            source_observation_ids: ids,
        });
        assert_eq!(
            errors,
            vec!["at most 100 source observations are allowed".to_string()]
        );
    }

    #[test]
    fn normalization_trims_deduplicates_and_sorts() {
        let ids = vec![
            " b ".to_string(),
            "a".to_string(),
            "".to_string(),
            "   ".to_string(),
            "b".to_string(),
            "a".to_string(),
        ];
        assert_eq!(
            normalized_source_observation_ids(&ids),
            vec!["a".to_string(), "b".to_string()]
        );
    }

    #[test]
    fn the_policy_version_is_one() {
        assert_eq!(CONSOLIDATION_POLICY_VERSION, "1");
    }
}
