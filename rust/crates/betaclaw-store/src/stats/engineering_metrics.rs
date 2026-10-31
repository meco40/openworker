//! Port of `src/server/stats/engineeringMetrics.ts`: the metric arithmetic and
//! the snapshot shape that the dashboards and the rollout gates read.
//!
//! Ratios are rounded to two decimals and the PR size to an integer, as in the
//! TypeScript. The optional fields are filled by `engineering_metrics_service`.

use serde::Serialize;

use super::harness_rollout::RolloutSummary;
use super::util::{js_round, parse_iso_ms, round_places};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SnapshotSource {
    Snapshot,
    Fallback,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompletedRunSignal {
    pub created_at: String,
    pub completed_at: String,
    pub requires_refinement: bool,
}

/// `EngineeringSignalSet`. The verification and async-failure lists hold one
/// flag per run: `passed` and `breachedSla`.
#[derive(Debug, Clone, PartialEq)]
pub struct EngineeringSignalSet {
    pub window_days: u32,
    pub completed_runs: Vec<CompletedRunSignal>,
    pub verification_passed: Vec<bool>,
    pub rollback_events: i64,
    pub merge_sized_changes: Vec<i64>,
    pub async_failure_breaches: Vec<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DomainCoverage {
    pub active_domains: i64,
    pub covered_domains: i64,
    pub coverage_rate: Option<f64>,
    pub uncovered_domains: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScenarioSuccessRate {
    pub scenario: String,
    pub success_rate: Option<f64>,
    pub total_runs: i64,
    pub flaky_suspicions: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeHarness {
    pub total_worktrees: i64,
    pub healthy_worktrees: i64,
    pub success_rate: Option<f64>,
    pub unstable_worktrees: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaneSuccessRate {
    pub lane: String,
    pub success_rate: Option<f64>,
    pub median_duration_ms: Option<i64>,
    pub flaky_suspicions: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Observability {
    pub lane_success_rates: Vec<LaneSuccessRate>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineeringMetricsSnapshot {
    pub window_days: u32,
    pub lead_time_median_hours: Option<f64>,
    pub merge_throughput_per_week: Option<f64>,
    pub first_pass_ci_rate: Option<f64>,
    pub flaky_rate: Option<f64>,
    pub revert_rate: Option<f64>,
    pub median_pr_size: Option<i64>,
    pub async_failure_sla_breaches: i64,
    pub generated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<SnapshotSource>,
    pub snapshot_age_hours: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_fallback: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub domain_coverage: Option<DomainCoverage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scenario_success_rates: Option<Vec<ScenarioSuccessRate>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree_harness: Option<WorktreeHarness>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub critical_fail_auto_reverts: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub observability: Option<Observability>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rollout: Option<RolloutSummary>,
}

/// `safeMedian`: the median of the finite values, `None` when there are none.
pub fn safe_median(values: &[f64]) -> Option<f64> {
    let mut sorted: Vec<f64> = values.iter().copied().filter(|v| v.is_finite()).collect();
    if sorted.is_empty() {
        return None;
    }
    sorted.sort_by(f64::total_cmp);
    let middle = sorted.len() / 2;
    if sorted.len() % 2 == 1 {
        Some(sorted[middle])
    } else {
        Some((sorted[middle - 1] + sorted[middle]) / 2.0)
    }
}

/// `toLeadTimeHours`: `None` for unparsable timestamps or a completion before
/// the creation.
fn lead_time_hours(run: &CompletedRunSignal) -> Option<f64> {
    let start = parse_iso_ms(&run.created_at)?;
    let end = parse_iso_ms(&run.completed_at)?;
    (end >= start).then(|| (end - start) as f64 / (60.0 * 60.0 * 1000.0))
}

/// `ratio`: `None` for an empty denominator.
fn ratio(numerator: f64, denominator: usize) -> Option<f64> {
    (denominator > 0).then(|| numerator / denominator as f64)
}

fn round2(value: f64) -> f64 {
    round_places(value, 2)
}

/// `computeEngineeringMetricsSnapshot`: the snapshot computed from raw signals.
/// The optional sections stay empty; the service adds them.
pub fn compute_engineering_metrics_snapshot(
    signals: &EngineeringSignalSet,
    generated_at: &str,
) -> EngineeringMetricsSnapshot {
    let lead_times: Vec<f64> = signals
        .completed_runs
        .iter()
        .filter_map(lead_time_hours)
        .collect();
    let merges = signals.completed_runs.len();
    let merge_sizes: Vec<f64> = signals
        .merge_sized_changes
        .iter()
        .map(|size| *size as f64)
        .collect();
    let passed = signals
        .verification_passed
        .iter()
        .filter(|passed| **passed)
        .count();
    let refinements = signals
        .completed_runs
        .iter()
        .filter(|run| run.requires_refinement)
        .count();
    let reverted = signals.rollback_events.max(0) as f64;
    let revert_denominator = merges.max(signals.merge_sized_changes.len());

    EngineeringMetricsSnapshot {
        window_days: signals.window_days,
        lead_time_median_hours: safe_median(&lead_times).map(round2),
        merge_throughput_per_week: (merges > 0)
            .then(|| round2(merges as f64 / (f64::from(signals.window_days) / 7.0))),
        first_pass_ci_rate: ratio(passed as f64, signals.verification_passed.len()).map(round2),
        flaky_rate: ratio(refinements as f64, merges).map(round2),
        revert_rate: ratio(reverted, revert_denominator).map(round2),
        median_pr_size: safe_median(&merge_sizes).map(|size| js_round(size) as i64),
        async_failure_sla_breaches: signals
            .async_failure_breaches
            .iter()
            .filter(|breached| **breached)
            .count() as i64,
        generated_at: generated_at.to_string(),
        source: None,
        snapshot_age_hours: None,
        is_fallback: None,
        domain_coverage: None,
        scenario_success_rates: None,
        worktree_harness: None,
        critical_fail_auto_reverts: None,
        observability: None,
        rollout: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(created: &str, completed: &str, refinement: bool) -> CompletedRunSignal {
        CompletedRunSignal {
            created_at: created.into(),
            completed_at: completed.into(),
            requires_refinement: refinement,
        }
    }

    #[test]
    fn computes_the_snapshot_from_raw_signals() {
        let signals = EngineeringSignalSet {
            window_days: 7,
            completed_runs: vec![
                run("2026-01-01T00:00:00Z", "2026-01-01T02:00:00Z", true),
                run("2026-01-02T00:00:00Z", "2026-01-02T04:00:00Z", false),
                run("2026-01-03T00:00:00Z", "2026-01-03T06:00:00Z", false),
            ],
            verification_passed: vec![true, false, true, true],
            rollback_events: 1,
            merge_sized_changes: vec![100, 200, 400],
            async_failure_breaches: vec![true, false],
        };
        let snapshot = compute_engineering_metrics_snapshot(&signals, "2026-01-04T00:00:00.000Z");

        assert_eq!(snapshot.lead_time_median_hours, Some(4.0));
        assert_eq!(snapshot.merge_throughput_per_week, Some(3.0));
        assert_eq!(snapshot.first_pass_ci_rate, Some(0.75));
        assert_eq!(snapshot.flaky_rate, Some(0.33));
        assert_eq!(snapshot.revert_rate, Some(0.33));
        assert_eq!(snapshot.median_pr_size, Some(200));
        assert_eq!(snapshot.async_failure_sla_breaches, 1);
        assert_eq!(snapshot.generated_at, "2026-01-04T00:00:00.000Z");
        assert!(snapshot.rollout.is_none());
    }

    #[test]
    fn empty_signals_give_null_ratios_not_zeros() {
        let signals = EngineeringSignalSet {
            window_days: 30,
            completed_runs: vec![],
            verification_passed: vec![],
            rollback_events: 0,
            merge_sized_changes: vec![],
            async_failure_breaches: vec![],
        };
        let snapshot = compute_engineering_metrics_snapshot(&signals, "t");
        assert_eq!(snapshot.lead_time_median_hours, None);
        assert_eq!(snapshot.merge_throughput_per_week, None);
        assert_eq!(snapshot.first_pass_ci_rate, None);
        assert_eq!(snapshot.revert_rate, None);
        assert_eq!(snapshot.median_pr_size, None);
    }

    #[test]
    fn a_completion_before_the_creation_has_no_lead_time() {
        let inverted = run("2026-01-02T00:00:00Z", "2026-01-01T00:00:00Z", false);
        assert_eq!(lead_time_hours(&inverted), None);
    }

    #[test]
    fn median_uses_the_mean_of_the_two_middle_values() {
        assert_eq!(safe_median(&[4.0, 1.0, 3.0, 2.0]), Some(2.5));
        assert_eq!(safe_median(&[f64::NAN, 5.0]), Some(5.0));
        assert_eq!(safe_median(&[]), None);
    }
}
