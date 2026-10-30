//! Port of `src/server/knowledge/recallScoring.ts` (1-59).
//!
//! | TypeScript                              | Rust |
//! | --------------------------------------- | ---- |
//! | `recallScoring.ts:8` (`TemporalStatus`)  | [`TemporalStatus`] |
//! | `recallScoring.ts:10-16` (`RecallScoreInput`) | [`RecallScoreInput`] |
//! | `recallScoring.ts:21-23` (`isDuplicateContent`) | [`is_duplicate_content`] |
//! | `recallScoring.ts:36-59` (`adjustRecallScore`) | [`adjust_recall_score`] |
//!
//! Dependency of `retrieval/ranking/{episodeRanker,ledgerRanker}.ts:2`; it lives
//! at the knowledge root because that is where its TypeScript original lives.
//!
//! The field spelling `isSupersceded` is the source's (`recallScoring.ts:15`,
//! one `e` after `supersc`); the port keeps it so a reviewer can diff the two
//! lines without a second thought.
//!
//! The arithmetic is JavaScript `number` arithmetic: `Math.max(0.5, confidence)`
//! and three multiplications, in the source's order, so the result is
//! bit-identical to the TypeScript for the same inputs.

/// `TemporalStatus` from `recallScoring.ts:8`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TemporalStatus {
    Current,
    Past,
    Planned,
    Unknown,
}

/// `RecallScoreInput` from `recallScoring.ts:10-16`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RecallScoreInput {
    pub base_score: f64,
    pub confidence: f64,
    pub age_days: f64,
    pub temporal_status: Option<TemporalStatus>,
    pub is_supersceded: Option<bool>,
}

/// `isDuplicateContent` from `recallScoring.ts:21-23`.
pub fn is_duplicate_content(new_content: &str, existing_content: &str) -> bool {
    new_content.trim().to_lowercase() == existing_content.trim().to_lowercase()
}

/// `adjustRecallScore` from `recallScoring.ts:36-59`.
///
/// Freshness: `1.0` below 7 days, `0.95` below 30, `0.85` below 90, `0.7` from
/// 90 days on. Temporal: `current` 1.1, `past` 0.8, everything else 1.0.
pub fn adjust_recall_score(input: &RecallScoreInput) -> f64 {
    if input.is_supersceded == Some(true) {
        return 0.0;
    }

    let confidence_boost = input.confidence.max(0.5);

    let freshness_boost = if input.age_days < 7.0 {
        1.0
    } else if input.age_days < 30.0 {
        0.95
    } else if input.age_days < 90.0 {
        0.85
    } else {
        0.7
    };

    let temporal_boost = match input.temporal_status {
        Some(TemporalStatus::Current) => 1.1,
        Some(TemporalStatus::Past) => 0.8,
        _ => 1.0,
    };

    input.base_score * confidence_boost * freshness_boost * temporal_boost
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(age_days: f64) -> RecallScoreInput {
        RecallScoreInput {
            base_score: 0.4,
            confidence: 0.5,
            age_days,
            temporal_status: None,
            is_supersceded: None,
        }
    }

    #[test]
    fn the_freshness_steps_are_the_four_bands_of_the_source() {
        assert_eq!(adjust_recall_score(&input(0.0)), 0.4 * 0.5);
        assert_eq!(adjust_recall_score(&input(6.999)), 0.4 * 0.5);
        assert_eq!(adjust_recall_score(&input(7.0)), 0.4 * 0.5 * 0.95);
        assert_eq!(adjust_recall_score(&input(30.0)), 0.4 * 0.5 * 0.85);
        assert_eq!(adjust_recall_score(&input(90.0)), 0.4 * 0.5 * 0.7);
    }

    #[test]
    fn the_confidence_floor_is_a_half() {
        let mut weak = input(1.0);
        weak.confidence = 0.1;
        assert_eq!(adjust_recall_score(&weak), 0.4 * 0.5);
    }

    #[test]
    fn a_superseded_fact_scores_zero_and_the_temporal_status_scales() {
        let mut superseded = input(1.0);
        superseded.is_supersceded = Some(true);
        assert_eq!(adjust_recall_score(&superseded), 0.0);

        let mut current = input(1.0);
        current.temporal_status = Some(TemporalStatus::Current);
        assert_eq!(adjust_recall_score(&current), 0.4 * 0.5 * 1.1);

        let mut past = input(1.0);
        past.temporal_status = Some(TemporalStatus::Past);
        assert_eq!(adjust_recall_score(&past), 0.4 * 0.5 * 0.8);

        let mut planned = input(1.0);
        planned.temporal_status = Some(TemporalStatus::Planned);
        assert_eq!(adjust_recall_score(&planned), 0.4 * 0.5);
    }

    #[test]
    fn duplicate_detection_ignores_case_and_surrounding_space() {
        assert!(is_duplicate_content("  Hallo Welt ", "hallo welt"));
        assert!(!is_duplicate_content("Hallo Welt", "hallo welt!"));
    }
}
