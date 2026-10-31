//! Port of `src/server/master/delegation/aggregator.ts:1-21`.
//!
//! A pure three-way classifier of one delegated result. `result.output` absent or
//! blank is `rejected` with an empty merge; a confidence below `0.5` is
//! `needs_rework`; everything else is `accepted`. The two non-rejected paths pass
//! the output through unchanged.

/// `AggregationStatus` from `aggregator.ts:1`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AggregationStatus {
    Accepted,
    NeedsRework,
    Rejected,
}

impl AggregationStatus {
    /// The TypeScript literal.
    pub fn as_str(self) -> &'static str {
        match self {
            AggregationStatus::Accepted => "accepted",
            AggregationStatus::NeedsRework => "needs_rework",
            AggregationStatus::Rejected => "rejected",
        }
    }
}

/// `DelegationResult` from `aggregator.ts:3-7`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct DelegationResult {
    pub summary: Option<String>,
    pub output: Option<String>,
    pub confidence: Option<f64>,
}

/// `{ status, mergedOutput }` — `aggregator.ts:9-11`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AggregationOutcome {
    pub status: AggregationStatus,
    pub merged_output: String,
}

/// `aggregateDelegationResult` — `aggregator.ts:9-21`.
pub fn aggregate_delegation_result(result: &DelegationResult) -> AggregationOutcome {
    let confidence = result.confidence.unwrap_or(0.0);
    let output_is_blank = result
        .output
        .as_deref()
        .map(|output| output.trim().is_empty())
        .unwrap_or(true);
    if output_is_blank {
        return AggregationOutcome {
            status: AggregationStatus::Rejected,
            merged_output: String::new(),
        };
    }
    let output = result.output.clone().unwrap_or_default();
    if confidence < 0.5 {
        return AggregationOutcome {
            status: AggregationStatus::NeedsRework,
            merged_output: output,
        };
    }
    AggregationOutcome {
        status: AggregationStatus::Accepted,
        merged_output: output,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn result(output: Option<&str>, confidence: Option<f64>) -> DelegationResult {
        DelegationResult {
            summary: None,
            output: output.map(str::to_string),
            confidence,
        }
    }

    #[test]
    fn a_blank_output_is_rejected() {
        for output in [None, Some(""), Some("   \n")] {
            let outcome = aggregate_delegation_result(&result(output, Some(0.9)));
            assert_eq!(outcome.status, AggregationStatus::Rejected);
            assert_eq!(outcome.merged_output, "");
        }
    }

    #[test]
    fn a_missing_confidence_is_zero() {
        let outcome = aggregate_delegation_result(&result(Some("body"), None));
        assert_eq!(outcome.status, AggregationStatus::NeedsRework);
        assert_eq!(outcome.merged_output, "body");
    }

    #[test]
    fn the_half_threshold_is_inclusive_accepted() {
        assert_eq!(
            aggregate_delegation_result(&result(Some("body"), Some(0.5))).status,
            AggregationStatus::Accepted
        );
        assert_eq!(
            aggregate_delegation_result(&result(Some("body"), Some(0.4999))).status,
            AggregationStatus::NeedsRework
        );
    }

    #[test]
    fn literals_round_trip() {
        assert_eq!(AggregationStatus::Accepted.as_str(), "accepted");
        assert_eq!(AggregationStatus::NeedsRework.as_str(), "needs_rework");
        assert_eq!(AggregationStatus::Rejected.as_str(), "rejected");
    }
}
