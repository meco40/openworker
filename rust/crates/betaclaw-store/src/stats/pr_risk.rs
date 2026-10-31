//! Port of `src/server/stats/prRiskClassifier.ts`.

use serde::Serialize;

use super::util::js_round;

const MEDIUM_THRESHOLD: f64 = 300.0;
const HIGH_THRESHOLD: f64 = 500.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PrRiskLevel {
    Low,
    Medium,
    High,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrRiskResult {
    pub level: PrRiskLevel,
    pub requires_split_reason: bool,
}

/// `sanitizeLinesChanged`: non-finite becomes 0, the rest is rounded and
/// clamped at 0.
fn sanitize_lines_changed(value: f64) -> f64 {
    if !value.is_finite() {
        return 0.0;
    }
    js_round(value).max(0.0)
}

/// Above 500 changed lines the PR is high risk and needs a split reason; from
/// 300 on it is medium.
pub fn classify_pr_risk(lines_changed: f64) -> PrRiskResult {
    let lines = sanitize_lines_changed(lines_changed);
    if lines > HIGH_THRESHOLD {
        return PrRiskResult {
            level: PrRiskLevel::High,
            requires_split_reason: true,
        };
    }
    let level = if lines >= MEDIUM_THRESHOLD {
        PrRiskLevel::Medium
    } else {
        PrRiskLevel::Low
    };
    PrRiskResult {
        level,
        requires_split_reason: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thresholds_are_inclusive_at_medium_and_exclusive_at_high() {
        assert_eq!(classify_pr_risk(299.0).level, PrRiskLevel::Low);
        assert_eq!(classify_pr_risk(300.0).level, PrRiskLevel::Medium);
        assert_eq!(classify_pr_risk(500.0).level, PrRiskLevel::Medium);
        let high = classify_pr_risk(501.0);
        assert_eq!(high.level, PrRiskLevel::High);
        assert!(high.requires_split_reason);
    }

    #[test]
    fn non_finite_and_negative_input_is_low_risk() {
        assert_eq!(classify_pr_risk(f64::NAN).level, PrRiskLevel::Low);
        assert_eq!(classify_pr_risk(f64::INFINITY).level, PrRiskLevel::Low);
        assert_eq!(classify_pr_risk(-400.0).level, PrRiskLevel::Low);
    }

    #[test]
    fn rounds_before_comparing() {
        assert_eq!(classify_pr_risk(299.5).level, PrRiskLevel::Medium);
    }
}
