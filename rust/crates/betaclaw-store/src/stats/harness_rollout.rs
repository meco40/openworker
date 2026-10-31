//! Port of `src/server/stats/harnessRollout.ts`.
//!
//! Evaluates the exit gates of `config/harness-rollout-gates.json` against
//! engineering metric snapshots. Snapshots stay JSON values, because the gates
//! address metrics by dotted path (`domainCoverage.coverageRate`), exactly how
//! the TypeScript reads them.
//!
//! Faithful quirk: a metric that is `null` in a snapshot is read as `0`
//! (JavaScript `Number(null)`). The gate then fails instead of reporting
//! `unknown`. The test `a_null_metric_reads_as_zero` pins this behaviour.

use std::collections::BTreeMap;
use std::path::Path;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::util::{finite, iso_millis, js_number, parse_iso_ms, round_places};
use super::StatsError;

string_enum!(GateStatus {
    Pass = "pass",
    Fail = "fail",
    Unknown = "unknown",
});

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RolloutMode {
    ReportOnly,
    Enforce,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Recommendation {
    Go,
    Hold,
    RollbackHardening,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum GateOperator {
    #[serde(rename = ">=")]
    Gte,
    #[serde(rename = "<=")]
    Lte,
    #[serde(rename = ">")]
    Gt,
    #[serde(rename = "<")]
    Lt,
    #[serde(rename = "==")]
    Eq,
}

impl GateOperator {
    fn compare(self, left: f64, right: f64) -> bool {
        match self {
            GateOperator::Gte => left >= right,
            GateOperator::Lte => left <= right,
            GateOperator::Gt => left > right,
            GateOperator::Lt => left < right,
            GateOperator::Eq => left == right,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessRolloutConfig {
    pub version: String,
    pub timezone: String,
    pub rollout_start: String,
    pub baseline: BaselineConfig,
    pub owners: OwnersConfig,
    pub sla: SlaConfig,
    pub phases: Vec<RolloutPhase>,
    pub go_no_go: GoNoGoConfig,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BaselineConfig {
    pub id: String,
    pub window_start: String,
    pub window_end: String,
    pub source: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnersConfig {
    pub rollout_gate_owner_var: String,
    pub go_no_go_owner_var: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlaConfig {
    pub default_hours: i64,
    pub override_var: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RolloutPhase {
    pub id: String,
    pub name: String,
    pub start: String,
    pub end: String,
    pub mode: RolloutMode,
    pub domains: Vec<String>,
    pub exit_gates: Vec<GateDefinition>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GateDefinition {
    pub id: String,
    pub label: String,
    pub window_days: u32,
    pub metric: String,
    pub operator: GateOperator,
    pub target: Option<f64>,
    pub target_from_baseline_delta: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoNoGoConfig {
    pub decision_dates: Vec<String>,
    pub recommendation_policy: RecommendationPolicy,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecommendationPolicy {
    pub pass: Recommendation,
    pub fail: Recommendation,
    pub unknown: Recommendation,
}

impl HarnessRolloutConfig {
    /// The fallback of `loadRolloutState` when the config cannot be read: no
    /// phases, so every evaluation reports `hold`.
    pub fn unavailable() -> Self {
        Self {
            version: "unknown".into(),
            timezone: "UTC".into(),
            rollout_start: String::new(),
            baseline: BaselineConfig {
                id: "unknown".into(),
                window_start: String::new(),
                window_end: String::new(),
                source: "unknown".into(),
            },
            owners: OwnersConfig {
                rollout_gate_owner_var: "ROLLOUT_GATE_OWNER".into(),
                go_no_go_owner_var: "GO_NO_GO_OWNER".into(),
            },
            sla: SlaConfig {
                default_hours: 24,
                override_var: "ROLLOUT_SLA_HOURS".into(),
            },
            phases: Vec::new(),
            go_no_go: GoNoGoConfig {
                decision_dates: Vec::new(),
                recommendation_policy: RecommendationPolicy {
                    pass: Recommendation::Go,
                    fail: Recommendation::Hold,
                    unknown: Recommendation::Hold,
                },
            },
        }
    }
}

/// A stored baseline (`engineering_rollout_baselines`).
#[derive(Debug, Clone, PartialEq)]
pub struct RolloutBaselineRecord {
    pub id: String,
    pub payload: Value,
    pub created_at: String,
    pub source: String,
    pub hash: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GateResult {
    pub id: String,
    pub label: String,
    pub status: GateStatus,
    pub window_days: u32,
    pub metric: String,
    pub operator: GateOperator,
    pub expected: Option<f64>,
    pub actual: Option<f64>,
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhaseWindow {
    pub start: Option<String>,
    pub end: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeltaVsBaseline {
    pub first_pass_ci_rate: Option<f64>,
    pub revert_rate: Option<f64>,
    pub flaky_rate: Option<f64>,
    pub merge_throughput_per_week: Option<f64>,
    pub median_pr_size: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RolloutSummary {
    pub phase: Option<String>,
    pub phase_window: PhaseWindow,
    pub mode: Option<RolloutMode>,
    pub baseline_id: Option<String>,
    pub overall_status: GateStatus,
    pub recommendation: Recommendation,
    pub exit_gates: Vec<GateResult>,
    pub delta_vs_baseline: DeltaVsBaseline,
}

/// `loadHarnessRolloutConfig`, with the path passed in by the caller.
pub fn load_harness_rollout_config(path: &Path) -> Result<HarnessRolloutConfig, StatsError> {
    let raw = std::fs::read_to_string(path)?;
    Ok(serde_json::from_str(&raw)?)
}

/// `getPathValue`: walks a dotted path through non-array objects. Empty parts
/// are skipped, as in the TypeScript.
pub fn get_path<'a>(input: Option<&'a Value>, dot_path: &str) -> Option<&'a Value> {
    let mut current = input;
    for part in dot_path
        .split('.')
        .map(str::trim)
        .filter(|part| !part.is_empty())
    {
        current = current?.as_object()?.get(part);
    }
    current
}

/// The phase whose inclusive `[start, end]` window contains `now`.
pub fn resolve_current_rollout_phase(
    config: &HarnessRolloutConfig,
    now: DateTime<Utc>,
) -> Option<&RolloutPhase> {
    let now_ms = now.timestamp_millis();
    config.phases.iter().find(|phase| {
        match (parse_iso_ms(&phase.start), parse_iso_ms(&phase.end)) {
            (Some(start), Some(end)) => now_ms >= start && now_ms <= end,
            _ => false,
        }
    })
}

/// Whether `now` falls on a UTC date listed in `goNoGo.decisionDates`.
pub fn is_go_no_go_date(config: &HarnessRolloutConfig, now: DateTime<Utc>) -> bool {
    let iso_date = iso_millis(now);
    let iso_date = &iso_date[..10];
    config
        .go_no_go
        .decision_dates
        .iter()
        .any(|date| date == iso_date)
}

/// `safeNumber` of a metric read at `dot_path`, `None` when it is not finite.
fn metric_number(input: Option<&Value>, dot_path: &str) -> Option<f64> {
    finite(js_number(get_path(input, dot_path)))
}

/// `metricDelta`, rounded to four places.
fn metric_delta(current: Option<&Value>, baseline: Option<&Value>, metric: &str) -> Option<f64> {
    let current = current?;
    let baseline = baseline?;
    let current_value = metric_number(Some(current), metric)?;
    let baseline_value = metric_number(Some(baseline), metric)?;
    Some(round_places(current_value - baseline_value, 4))
}

fn evaluate_gate(
    gate: &GateDefinition,
    snapshots: &BTreeMap<u32, Value>,
    baseline_payload: Option<&Value>,
) -> GateResult {
    let result = |status, expected, actual, detail: String| GateResult {
        id: gate.id.clone(),
        label: gate.label.clone(),
        status,
        window_days: gate.window_days,
        metric: gate.metric.clone(),
        operator: gate.operator,
        expected,
        actual,
        detail,
    };

    let Some(snapshot) = snapshots.get(&gate.window_days) else {
        return result(
            GateStatus::Unknown,
            None,
            None,
            format!("No snapshot available for window {}d.", gate.window_days),
        );
    };
    let Some(actual) = metric_number(Some(snapshot), &gate.metric) else {
        return result(
            GateStatus::Unknown,
            None,
            None,
            format!(
                "Metric {} missing in {}d snapshot.",
                gate.metric, gate.window_days
            ),
        );
    };

    let mut expected = gate.target.and_then(finite);
    if expected.is_none() {
        if let Some(delta) = gate.target_from_baseline_delta {
            match metric_number(baseline_payload, &gate.metric) {
                Some(baseline_value) => expected = Some(baseline_value + delta),
                None => {
                    return result(
                        GateStatus::Unknown,
                        None,
                        Some(actual),
                        format!(
                            "Baseline metric {} missing for delta-based gate.",
                            gate.metric
                        ),
                    );
                }
            }
        }
    }
    let Some(expected) = expected else {
        return result(
            GateStatus::Unknown,
            None,
            Some(actual),
            "Gate target is missing.".into(),
        );
    };

    let passed = gate.operator.compare(actual, expected);
    result(
        if passed {
            GateStatus::Pass
        } else {
            GateStatus::Fail
        },
        Some(round_places(expected, 4)),
        Some(round_places(actual, 4)),
        if passed {
            "Gate passed.".into()
        } else {
            "Gate failed.".into()
        },
    )
}

/// `evaluateHarnessRollout`. `snapshots` is keyed by window in days, and the
/// baseline is the stored record or `None`.
pub fn evaluate_harness_rollout(
    config: &HarnessRolloutConfig,
    snapshots: &BTreeMap<u32, Value>,
    baseline: Option<&RolloutBaselineRecord>,
    now: DateTime<Utc>,
) -> RolloutSummary {
    let baseline_id = baseline
        .map(|record| record.id.clone())
        .unwrap_or_else(|| config.baseline.id.clone());
    let baseline_payload = baseline.map(|record| &record.payload);

    let Some(phase) = resolve_current_rollout_phase(config, now) else {
        return RolloutSummary {
            phase: None,
            phase_window: PhaseWindow {
                start: None,
                end: None,
            },
            mode: None,
            baseline_id: Some(baseline_id),
            overall_status: GateStatus::Unknown,
            recommendation: Recommendation::Hold,
            exit_gates: Vec::new(),
            delta_vs_baseline: DeltaVsBaseline::default(),
        };
    };

    let exit_gates: Vec<GateResult> = phase
        .exit_gates
        .iter()
        .map(|gate| evaluate_gate(gate, snapshots, baseline_payload))
        .collect();

    let overall_status = if exit_gates
        .iter()
        .any(|gate| gate.status == GateStatus::Fail)
    {
        GateStatus::Fail
    } else if exit_gates
        .iter()
        .any(|gate| gate.status == GateStatus::Unknown)
    {
        GateStatus::Unknown
    } else {
        GateStatus::Pass
    };
    let policy = config.go_no_go.recommendation_policy;
    let recommendation = match overall_status {
        GateStatus::Pass => policy.pass,
        GateStatus::Fail => policy.fail,
        GateStatus::Unknown => policy.unknown,
    };

    let snapshot_30 = snapshots.get(&30);
    let snapshot_7 = snapshots.get(&7);
    RolloutSummary {
        phase: Some(phase.id.clone()),
        phase_window: PhaseWindow {
            start: Some(phase.start.clone()),
            end: Some(phase.end.clone()),
        },
        mode: Some(phase.mode),
        baseline_id: Some(baseline_id),
        overall_status,
        recommendation,
        exit_gates,
        delta_vs_baseline: DeltaVsBaseline {
            first_pass_ci_rate: metric_delta(snapshot_30, baseline_payload, "firstPassCiRate"),
            revert_rate: metric_delta(snapshot_30, baseline_payload, "revertRate"),
            flaky_rate: metric_delta(snapshot_7.or(snapshot_30), baseline_payload, "flakyRate"),
            merge_throughput_per_week: metric_delta(
                snapshot_30,
                baseline_payload,
                "mergeThroughputPerWeek",
            ),
            median_pr_size: metric_delta(snapshot_30, baseline_payload, "medianPrSize"),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn config() -> HarnessRolloutConfig {
        serde_json::from_value(json!({
            "version": "test",
            "timezone": "UTC",
            "rolloutStart": "2026-03-09T00:00:00Z",
            "baseline": {
                "id": "baseline-1", "windowStart": "2026-02-07T00:00:00Z",
                "windowEnd": "2026-03-08T23:59:59Z", "source": "snapshot"
            },
            "owners": { "rolloutGateOwnerVar": "A", "goNoGoOwnerVar": "B" },
            "sla": { "defaultHours": 24, "overrideVar": "C" },
            "phases": [
                {
                    "id": "week-1", "name": "Shadow",
                    "start": "2026-03-09T00:00:00Z", "end": "2026-03-15T23:59:59Z",
                    "mode": "report-only", "domains": ["all"],
                    "exitGates": [
                        { "id": "coverage", "label": "Coverage", "windowDays": 30,
                          "metric": "domainCoverage.coverageRate", "operator": ">=", "target": 1 },
                        { "id": "ingest", "label": "Ingest", "windowDays": 30,
                          "metric": "meta.ingestSuccessRate", "operator": ">=", "target": 0.99 }
                    ]
                },
                {
                    "id": "week-4", "name": "Go/No-Go",
                    "start": "2026-03-30T00:00:00Z", "end": "2026-04-05T23:59:59Z",
                    "mode": "enforce", "domains": ["core-api"],
                    "exitGates": [
                        { "id": "first-pass", "label": "First pass", "windowDays": 30,
                          "metric": "firstPassCiRate", "operator": ">=", "targetFromBaselineDelta": 0.15 },
                        { "id": "flaky", "label": "Flaky", "windowDays": 7,
                          "metric": "flakyRate", "operator": "<=", "target": 0.02 }
                    ]
                }
            ],
            "goNoGo": {
                "decisionDates": ["2026-04-05"],
                "recommendationPolicy": { "pass": "go", "fail": "hold", "unknown": "hold" }
            }
        }))
        .expect("fixture parses")
    }

    fn at(rfc3339: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(rfc3339)
            .expect("valid time")
            .with_timezone(&Utc)
    }

    fn snapshots(window: u32, payload: Value) -> BTreeMap<u32, Value> {
        BTreeMap::from([(window, payload)])
    }

    #[test]
    fn a_missing_metric_leaves_the_gate_unknown_and_holds() {
        let summary = evaluate_harness_rollout(
            &config(),
            &snapshots(30, json!({ "domainCoverage": { "coverageRate": 1.0 } })),
            None,
            at("2026-03-10T12:00:00Z"),
        );
        assert_eq!(summary.phase.as_deref(), Some("week-1"));
        assert_eq!(summary.exit_gates[0].status, GateStatus::Pass);
        assert_eq!(summary.exit_gates[1].status, GateStatus::Unknown);
        assert_eq!(
            summary.exit_gates[1].detail,
            "Metric meta.ingestSuccessRate missing in 30d snapshot."
        );
        assert_eq!(summary.overall_status, GateStatus::Unknown);
        assert_eq!(summary.recommendation, Recommendation::Hold);
        assert_eq!(summary.baseline_id.as_deref(), Some("baseline-1"));
    }

    #[test]
    fn no_phase_for_the_date_holds_with_no_gates() {
        let summary = evaluate_harness_rollout(
            &config(),
            &BTreeMap::new(),
            None,
            at("2025-01-01T00:00:00Z"),
        );
        assert_eq!(summary.phase, None);
        assert!(summary.exit_gates.is_empty());
        assert_eq!(summary.recommendation, Recommendation::Hold);
    }

    #[test]
    fn delta_based_gate_uses_the_baseline_plus_the_delta() {
        let baseline = RolloutBaselineRecord {
            id: "baseline-1".into(),
            payload: json!({ "firstPassCiRate": 0.5, "flakyRate": 0.01 }),
            created_at: String::new(),
            source: String::new(),
            hash: String::new(),
        };
        let now = at("2026-03-31T12:00:00Z");
        // Required: 0.5 + 0.15 = 0.65.
        let short = BTreeMap::from([
            (30, json!({ "firstPassCiRate": 0.6 })),
            (7, json!({ "flakyRate": 0.01 })),
        ]);
        let failing = evaluate_harness_rollout(&config(), &short, Some(&baseline), now);
        assert_eq!(failing.exit_gates[0].status, GateStatus::Fail);
        assert_eq!(failing.exit_gates[0].expected, Some(0.65));
        assert_eq!(failing.recommendation, Recommendation::Hold);

        let passing_snapshots = BTreeMap::from([
            (30, json!({ "firstPassCiRate": 0.7 })),
            (7, json!({ "flakyRate": 0.01 })),
        ]);
        let passing = evaluate_harness_rollout(&config(), &passing_snapshots, Some(&baseline), now);
        assert_eq!(passing.exit_gates[0].status, GateStatus::Pass);
        assert_eq!(passing.exit_gates[1].status, GateStatus::Pass);
        assert_eq!(passing.overall_status, GateStatus::Pass);
        assert_eq!(passing.recommendation, Recommendation::Go);
        assert_eq!(passing.delta_vs_baseline.first_pass_ci_rate, Some(0.2));
        assert_eq!(passing.delta_vs_baseline.flaky_rate, Some(0.0));
    }

    #[test]
    fn a_null_metric_reads_as_zero() {
        // Faithful to `Number(null) === 0`: the gate fails, it is not unknown.
        let baseline = RolloutBaselineRecord {
            id: "b".into(),
            payload: json!({ "firstPassCiRate": 0.5 }),
            created_at: String::new(),
            source: String::new(),
            hash: String::new(),
        };
        let summary = evaluate_harness_rollout(
            &config(),
            &BTreeMap::from([(30, json!({ "firstPassCiRate": null }))]),
            Some(&baseline),
            at("2026-03-31T12:00:00Z"),
        );
        assert_eq!(summary.exit_gates[0].status, GateStatus::Fail);
        assert_eq!(summary.exit_gates[0].actual, Some(0.0));
    }

    #[test]
    fn dotted_paths_skip_arrays_and_empty_parts() {
        let value = json!({ "a": { "b": 2 }, "list": [1, 2] });
        assert_eq!(get_path(Some(&value), "a..b"), Some(&json!(2)));
        assert_eq!(get_path(Some(&value), "list.0"), None);
        assert_eq!(get_path(None, "a"), None);
    }

    #[test]
    fn the_unavailable_config_has_no_phases() {
        let config = HarnessRolloutConfig::unavailable();
        assert!(config.phases.is_empty());
        assert_eq!(
            config.go_no_go.recommendation_policy.pass,
            Recommendation::Go
        );
    }

    #[test]
    fn decision_dates_match_the_utc_day() {
        assert!(is_go_no_go_date(&config(), at("2026-04-05T23:59:00Z")));
        assert!(!is_go_no_go_date(&config(), at("2026-04-04T23:59:00Z")));
    }
}
