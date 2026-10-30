//! Port of `src/server/stats/engineeringMetricsService.ts`: the repository side
//! and the payload handling. The signal reads (`resolveScopes`,
//! `collectRunSignals`, `collectMergeSizedChanges`, `collectAsyncFailures`) are in
//! `engineering_signal_sources`, behind the master and task traits.
//!
//! Not ported here: `loadDomainRegistry` (`src/server/ci/harnessDomainRegistry.ts`).
//! The caller passes the active domain ids in [`CollectData::active_domains`].
//!
//! Payload reads follow the TypeScript: a key counts with its camelCase or its
//! snake_case spelling, and `null` numbers read as `0`.

use std::collections::{BTreeMap, HashSet};
use std::path::Path;

use chrono::{DateTime, Utc};
use serde_json::{Map, Value};

use super::engineering_metrics::{
    compute_engineering_metrics_snapshot, DomainCoverage, EngineeringMetricsSnapshot,
    EngineeringSignalSet, LaneSuccessRate, Observability, ScenarioSuccessRate, SnapshotSource,
    WorktreeHarness,
};
use super::engineering_snapshot_repository::{
    DomainStat, EngineeringSnapshotRepository, LaneStat, ScenarioStat, StoredSnapshot, WorktreeStat,
};
use super::harness_rollout::{
    evaluate_harness_rollout, load_harness_rollout_config, HarnessRolloutConfig,
    RolloutBaselineRecord,
};
use super::util::{
    finite, iso_from_ms, iso_millis, js_number, js_parse_int, js_round, parse_iso_ms, round_places,
};
use super::StatsError;

const DAY_MS: i64 = 24 * 60 * 60 * 1000;
const HOUR_MS: f64 = 60.0 * 60.0 * 1000.0;
const ASYNC_FAILURE_SLA_MS: i64 = 24 * 60 * 60 * 1000;
const SNAPSHOT_STALE_MS: i64 = 26 * 60 * 60 * 1000;

/// `parseWindowDays`: `None` or an empty string is 30, otherwise `parseInt`
/// must give 7 or 30. `"7.5"` is accepted as 7, as in the TypeScript.
pub fn parse_window_days(raw: Option<&str>) -> Result<u32, StatsError> {
    let Some(raw) = raw.filter(|value| !value.is_empty()) else {
        return Ok(30);
    };
    match js_parse_int(raw) {
        Some(7) => Ok(7),
        Some(30) => Ok(30),
        _ => Err(StatsError::InvalidWindowDays),
    }
}

/// `extractMergeSize`: the first of the four size fields that holds a positive
/// number, rounded. Malformed metadata gives `None`.
pub fn extract_merge_size(metadata: Option<&str>) -> Option<i64> {
    let parsed: Value = serde_json::from_str(metadata?).ok()?;
    let object = parsed.as_object()?;
    ["linesChanged", "changedLines", "changed_lines", "diffLines"]
        .iter()
        .find_map(|key| {
            let numeric = js_number(object.get(*key));
            (numeric.is_finite() && numeric > 0.0).then(|| js_round(numeric) as i64)
        })
}

/// The per-task rule of `collectAsyncFailures`: a failed task breaches the SLA
/// when it is neither done nor in review and its last failure or update is more
/// than 24 hours old.
pub fn async_failure_breached(
    status: Option<&str>,
    updated_at: Option<&str>,
    failed_at: Option<&str>,
    now_ms: i64,
) -> bool {
    let normalized = status.unwrap_or("").trim().to_lowercase();
    let closed = normalized == "done" || normalized == "review";
    let failed_ms = failed_at.and_then(parse_iso_ms).unwrap_or(0);
    let updated_ms = updated_at.and_then(parse_iso_ms).unwrap_or(0);
    let reference = failed_ms.max(updated_ms);
    !closed && reference > 0 && now_ms - reference > ASYNC_FAILURE_SLA_MS
}

/// `fromIso` of the window: `now` minus `windowDays`, in epoch-millisecond arithmetic.
pub fn window_start_iso(now: DateTime<Utc>, window_days: u32) -> String {
    iso_from_ms(now.timestamp_millis() - i64::from(window_days) * DAY_MS).unwrap_or_default()
}

/// `readPayloadNumber`: the first key whose value is a finite number.
fn read_number(payload: &Map<String, Value>, keys: &[&str]) -> Option<f64> {
    keys.iter()
        .find_map(|key| finite(js_number(payload.get(*key))))
}

/// `readPayloadObject`: the first key whose value is an object (not an array).
fn read_object<'a>(
    payload: &'a Map<String, Value>,
    keys: &[&str],
) -> Option<&'a Map<String, Value>> {
    keys.iter().find_map(|key| payload.get(*key)?.as_object())
}

/// `readPayloadArray`: the first key whose value is an array.
fn read_array<'a>(payload: &'a Map<String, Value>, keys: &[&str]) -> Option<&'a Vec<Value>> {
    keys.iter().find_map(|key| payload.get(*key)?.as_array())
}

/// `numericOrNull`: `null` and `""` are missing; anything else must be finite.
fn numeric_or_null(value: Option<&Value>) -> Option<f64> {
    match value {
        None | Some(Value::Null) => None,
        Some(Value::String(text)) if text.is_empty() => None,
        other => finite(js_number(other)),
    }
}

/// `integerOrZero`: a rounded, non-negative integer, `0` when not finite.
fn to_integer_or_zero(parsed: f64) -> i64 {
    if parsed.is_finite() {
        js_round(parsed).max(0.0) as i64
    } else {
        0
    }
}

/// `String(value || '').trim()` for the string fields of the payload.
fn trimmed_string(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string()
}

/// `round2(successes / total)`, `None` when there are no runs.
fn rate(successes: i64, total: i64) -> Option<f64> {
    (total > 0).then(|| round_places(successes as f64 / total as f64, 2))
}

/// The sections computed from the repository rows, shared by both paths.
#[derive(Debug, Clone)]
struct Computed {
    lanes: Vec<LaneSuccessRate>,
    domain_coverage: DomainCoverage,
    scenario_rates: Vec<ScenarioSuccessRate>,
    worktree: WorktreeHarness,
    guardian_auto_reverts: i64,
}

fn compute_sections(data: &CollectData) -> Computed {
    let lanes = data
        .lane_stats
        .iter()
        .map(|row| LaneSuccessRate {
            lane: row.lane.clone(),
            success_rate: rate(row.success_runs, row.total_runs),
            median_duration_ms: row.median_duration_ms,
            flaky_suspicions: row.flaky_suspicions,
        })
        .collect();

    let covered: HashSet<&str> = data
        .domain_stats
        .iter()
        .filter(|row| row.total_runs > 0)
        .map(|row| row.domain.as_str())
        .collect();
    let covered_domains = data
        .active_domains
        .iter()
        .filter(|id| covered.contains(id.as_str()))
        .count();
    let uncovered_domains: Vec<String> = data
        .active_domains
        .iter()
        .filter(|id| !covered.contains(id.as_str()))
        .cloned()
        .collect();
    let active = data.active_domains.len();
    let domain_coverage = DomainCoverage {
        active_domains: active as i64,
        covered_domains: covered_domains as i64,
        coverage_rate: (active > 0)
            .then(|| round_places(covered_domains as f64 / active as f64, 2)),
        uncovered_domains,
    };

    let scenario_rates = data
        .scenario_stats
        .iter()
        .map(|row: &ScenarioStat| ScenarioSuccessRate {
            scenario: row.scenario.clone(),
            success_rate: rate(row.success_runs, row.total_runs),
            total_runs: row.total_runs,
            flaky_suspicions: row.flaky_suspicions,
        })
        .collect();

    let worktrees: &[WorktreeStat] = &data.worktree_stats;
    let healthy = worktrees
        .iter()
        .filter(|row| row.total_runs > 0 && row.success_runs == row.total_runs)
        .count();
    let unstable = worktrees
        .iter()
        .filter(|row| row.total_runs > 0 && row.success_runs < row.total_runs)
        .count();
    let worktree = WorktreeHarness {
        total_worktrees: worktrees.len() as i64,
        healthy_worktrees: healthy as i64,
        success_rate: (!worktrees.is_empty())
            .then(|| round_places(healthy as f64 / worktrees.len() as f64, 2)),
        unstable_worktrees: unstable as i64,
    };

    Computed {
        lanes,
        domain_coverage,
        scenario_rates,
        worktree,
        guardian_auto_reverts: data.guardian_auto_reverts,
    }
}

/// `domainCoverage` as stored in a payload, with the same key fallbacks.
fn domain_coverage_from_payload(coverage: &Map<String, Value>) -> DomainCoverage {
    DomainCoverage {
        active_domains: to_integer_or_zero(js_number(coverage.get("activeDomains"))),
        covered_domains: to_integer_or_zero(js_number(coverage.get("coveredDomains"))),
        coverage_rate: numeric_or_null(coverage.get("coverageRate")),
        // Non-string entries are dropped; the pipeline only writes strings.
        uncovered_domains: coverage
            .get("uncoveredDomains")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::trim)
                    .filter(|domain| !domain.is_empty())
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default(),
    }
}

fn scenario_from_payload(entry: &Value) -> Option<ScenarioSuccessRate> {
    let row = entry.as_object()?;
    let scenario = trimmed_string(row.get("scenario"));
    (!scenario.is_empty()).then(|| ScenarioSuccessRate {
        scenario,
        success_rate: numeric_or_null(row.get("successRate")),
        total_runs: to_integer_or_zero(js_number(row.get("totalRuns"))),
        flaky_suspicions: to_integer_or_zero(js_number(row.get("flakySuspicions"))),
    })
}

fn worktree_from_payload(worktree: &Map<String, Value>) -> WorktreeHarness {
    WorktreeHarness {
        total_worktrees: to_integer_or_zero(js_number(worktree.get("totalWorktrees"))),
        healthy_worktrees: to_integer_or_zero(js_number(worktree.get("healthyWorktrees"))),
        success_rate: numeric_or_null(worktree.get("successRate")),
        unstable_worktrees: to_integer_or_zero(js_number(worktree.get("unstableWorktrees"))),
    }
}

/// The fresh-snapshot branch: the stored payload with the computed sections as
/// the fallback for every section the payload leaves out.
fn snapshot_from_stored(
    window_days: u32,
    stored: &StoredSnapshot,
    payload: &Map<String, Value>,
    generated_ms: i64,
    now_ms: i64,
    computed: &Computed,
) -> EngineeringMetricsSnapshot {
    let payload_coverage = read_object(payload, &["domainCoverage", "domain_coverage"]);
    let payload_scenarios =
        read_array(payload, &["scenarioSuccessRates", "scenario_success_rates"]);
    let payload_worktree = read_object(payload, &["worktreeHarness", "worktree_harness"]);
    let payload_reverts = read_number(
        payload,
        &["criticalFailAutoReverts", "critical_fail_auto_reverts"],
    );

    EngineeringMetricsSnapshot {
        window_days,
        lead_time_median_hours: read_number(
            payload,
            &["leadTimeMedianHours", "lead_time_median_hours"],
        ),
        merge_throughput_per_week: read_number(
            payload,
            &["mergeThroughputPerWeek", "merge_throughput_per_week"],
        ),
        first_pass_ci_rate: read_number(payload, &["firstPassCiRate", "first_pass_ci_rate"]),
        flaky_rate: read_number(payload, &["flakyRate", "flaky_rate"]),
        revert_rate: read_number(payload, &["revertRate", "revert_rate"]),
        median_pr_size: read_number(payload, &["medianPrSize", "median_pr_size"])
            .map(|size| js_round(size) as i64),
        async_failure_sla_breaches: read_number(
            payload,
            &["asyncFailureSlaBreaches", "async_failure_sla_breaches"],
        )
        .map_or(0, to_integer_or_zero),
        generated_at: stored.generated_at.clone(),
        source: Some(SnapshotSource::Snapshot),
        snapshot_age_hours: Some(round_places((now_ms - generated_ms) as f64 / HOUR_MS, 2)),
        is_fallback: Some(false),
        domain_coverage: Some(
            payload_coverage
                .map(domain_coverage_from_payload)
                .unwrap_or_else(|| computed.domain_coverage.clone()),
        ),
        scenario_success_rates: Some(match payload_scenarios {
            Some(entries) => entries.iter().filter_map(scenario_from_payload).collect(),
            None => computed.scenario_rates.clone(),
        }),
        worktree_harness: Some(
            payload_worktree
                .map(worktree_from_payload)
                .unwrap_or_else(|| computed.worktree.clone()),
        ),
        critical_fail_auto_reverts: Some(match payload_reverts {
            None => computed.guardian_auto_reverts,
            Some(value) => to_integer_or_zero(value),
        }),
        observability: Some(Observability {
            lane_success_rates: computed.lanes.clone(),
        }),
        rollout: None,
    }
}

/// `loadRolloutState`'s result: the config and the baseline in use.
#[derive(Debug, Clone)]
pub struct RolloutState {
    pub config: HarnessRolloutConfig,
    pub baseline: Option<RolloutBaselineRecord>,
}

fn try_load_rollout_state(
    config_path: &Path,
    repository: &EngineeringSnapshotRepository,
) -> Result<RolloutState, StatsError> {
    let config = load_harness_rollout_config(config_path)?;
    let baseline = match repository.rollout_baseline_by_id(&config.baseline.id)? {
        Some(record) => Some(record),
        None => repository.latest_rollout_baseline()?,
    };
    Ok(RolloutState {
        config,
        baseline: baseline.map(|record| RolloutBaselineRecord {
            id: record.id,
            payload: record.payload,
            created_at: record.created_at,
            source: record.source,
            hash: record.baseline_hash,
        }),
    })
}

/// `loadRolloutState`: any failure yields the unavailable config and no baseline.
pub fn load_rollout_state(
    config_path: &Path,
    repository: &EngineeringSnapshotRepository,
) -> RolloutState {
    try_load_rollout_state(config_path, repository).unwrap_or_else(|_| RolloutState {
        config: HarnessRolloutConfig::unavailable(),
        baseline: None,
    })
}

/// Everything `collectEngineeringMetricsSnapshot` reads for one window.
#[derive(Debug, Clone)]
pub struct CollectData {
    pub active_domains: Vec<String>,
    pub lane_stats: Vec<LaneStat>,
    pub domain_stats: Vec<DomainStat>,
    pub scenario_stats: Vec<ScenarioStat>,
    pub worktree_stats: Vec<WorktreeStat>,
    pub guardian_auto_reverts: i64,
    /// The newest stored snapshot of the window.
    pub latest: Option<StoredSnapshot>,
    pub rollout: RolloutState,
}

/// Reads the repository side of `collectEngineeringMetricsSnapshot` for the
/// window that ends at `now`.
pub fn gather_collect_data(
    repository: &EngineeringSnapshotRepository,
    window_days: u32,
    now: DateTime<Utc>,
    active_domains: Vec<String>,
    rollout_config_path: &Path,
) -> Result<CollectData, StatsError> {
    let from_iso = window_start_iso(now, window_days);
    Ok(CollectData {
        active_domains,
        lane_stats: repository.harness_lane_stats(&from_iso)?,
        domain_stats: repository.harness_domain_stats(&from_iso)?,
        scenario_stats: repository.harness_scenario_stats(&from_iso)?,
        worktree_stats: repository.harness_worktree_stats(&from_iso)?,
        guardian_auto_reverts: repository.guardian_auto_revert_count(&from_iso)?,
        latest: repository.latest_snapshot(window_days)?,
        rollout: load_rollout_state(rollout_config_path, repository),
    })
}

/// Adds the rollout evaluation. The gates address the snapshot by dotted path,
/// so the snapshot is evaluated as JSON, as in the TypeScript.
fn attach_rollout(
    mut snapshot: EngineeringMetricsSnapshot,
    data: &CollectData,
    now: DateTime<Utc>,
) -> EngineeringMetricsSnapshot {
    // The struct serialises without failing: it holds only finite numbers and strings.
    let value = serde_json::to_value(&snapshot).unwrap_or(Value::Null);
    let snapshots = BTreeMap::from([(snapshot.window_days, value)]);
    snapshot.rollout = Some(evaluate_harness_rollout(
        &data.rollout.config,
        &snapshots,
        data.rollout.baseline.as_ref(),
        now,
    ));
    snapshot
}

/// `collectEngineeringMetricsSnapshot`. A stored snapshot younger than 26 hours
/// is served as is; otherwise the snapshot is computed from the signals, which
/// `fallback_signals` collects only when that path is taken.
pub fn collect_engineering_metrics_snapshot(
    window_days: u32,
    now: DateTime<Utc>,
    data: &CollectData,
    fallback_signals: impl FnOnce() -> EngineeringSignalSet,
) -> EngineeringMetricsSnapshot {
    let now_ms = now.timestamp_millis();
    let computed = compute_sections(data);

    if let Some(stored) = &data.latest {
        let fresh_payload = stored
            .payload
            .as_object()
            .zip(parse_iso_ms(&stored.generated_at));
        if let Some((payload, generated_ms)) = fresh_payload {
            if now_ms - generated_ms <= SNAPSHOT_STALE_MS {
                let snapshot = snapshot_from_stored(
                    window_days,
                    stored,
                    payload,
                    generated_ms,
                    now_ms,
                    &computed,
                );
                return attach_rollout(snapshot, data, now);
            }
        }
    }

    let signals = fallback_signals();
    let generated_at = iso_millis(now);
    let computed_snapshot = compute_engineering_metrics_snapshot(&signals, &generated_at);
    let snapshot_age_hours = data
        .latest
        .as_ref()
        .and_then(|stored| parse_iso_ms(&stored.generated_at))
        .map(|parsed| {
            // `parseIsoMs(...) || nowMs`: a zero timestamp counts as now.
            let anchor = if parsed == 0 { now_ms } else { parsed };
            round_places((now_ms - anchor) as f64 / HOUR_MS, 2)
        });
    let snapshot = EngineeringMetricsSnapshot {
        source: Some(SnapshotSource::Fallback),
        snapshot_age_hours,
        is_fallback: Some(true),
        domain_coverage: Some(computed.domain_coverage),
        scenario_success_rates: Some(computed.scenario_rates),
        worktree_harness: Some(computed.worktree),
        critical_fail_auto_reverts: Some(computed.guardian_auto_reverts),
        observability: Some(Observability {
            lane_success_rates: computed.lanes,
        }),
        ..computed_snapshot
    };
    attach_rollout(snapshot, data, now)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::cell::Cell;

    fn now() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-06-10T12:00:00Z")
            .expect("valid")
            .with_timezone(&Utc)
    }

    fn data(latest: Option<StoredSnapshot>) -> CollectData {
        CollectData {
            active_domains: vec!["a".into(), "b".into()],
            lane_stats: vec![LaneStat {
                lane: "unit".into(),
                total_runs: 4,
                success_runs: 3,
                median_duration_ms: Some(1200),
                flaky_suspicions: 1,
            }],
            domain_stats: vec![DomainStat {
                domain: "a".into(),
                total_runs: 2,
                success_runs: 2,
            }],
            scenario_stats: vec![],
            worktree_stats: vec![WorktreeStat {
                worktree_id: "w".into(),
                total_runs: 2,
                success_runs: 2,
                last_finished_at: None,
            }],
            guardian_auto_reverts: 4,
            latest,
            rollout: RolloutState {
                config: HarnessRolloutConfig::unavailable(),
                baseline: None,
            },
        }
    }

    fn stored(generated_at: &str, payload: Value) -> StoredSnapshot {
        StoredSnapshot {
            window_days: 30,
            payload,
            source: "snapshot".into(),
            generated_at: generated_at.into(),
            created_at: generated_at.into(),
        }
    }

    fn signals() -> EngineeringSignalSet {
        EngineeringSignalSet {
            window_days: 30,
            completed_runs: vec![],
            verification_passed: vec![true],
            rollback_events: 0,
            merge_sized_changes: vec![],
            async_failure_breaches: vec![],
        }
    }

    #[test]
    fn window_days_default_and_allowed_values() {
        assert_eq!(parse_window_days(None).expect("default"), 30);
        assert_eq!(parse_window_days(Some("")).expect("empty"), 30);
        assert_eq!(parse_window_days(Some("7")).expect("seven"), 7);
        assert_eq!(parse_window_days(Some("7.5")).expect("js parseInt"), 7);
        assert!(parse_window_days(Some("14")).is_err());
        assert!(parse_window_days(Some("abc")).is_err());
    }

    #[test]
    fn merge_size_takes_the_first_positive_candidate() {
        assert_eq!(
            extract_merge_size(Some(r#"{"changedLines": 120.4}"#)),
            Some(120)
        );
        assert_eq!(
            extract_merge_size(Some(r#"{"linesChanged": "0", "diffLines": 7}"#)),
            Some(7)
        );
        assert_eq!(extract_merge_size(Some(r#"{"linesChanged": -5}"#)), None);
        assert_eq!(extract_merge_size(Some("not json")), None);
        assert_eq!(extract_merge_size(None), None);
    }

    #[test]
    fn async_failure_breach_needs_an_open_task_older_than_a_day() {
        let now_ms = now().timestamp_millis();
        let old = "2026-06-09T00:00:00.000Z";
        let recent = "2026-06-10T11:00:00.000Z";
        assert!(async_failure_breached(
            Some("in_progress"),
            Some(old),
            None,
            now_ms
        ));
        assert!(!async_failure_breached(
            Some("review"),
            Some(old),
            None,
            now_ms
        ));
        assert!(!async_failure_breached(
            Some("in_progress"),
            Some(recent),
            None,
            now_ms
        ));
        assert!(!async_failure_breached(
            Some("in_progress"),
            None,
            None,
            now_ms
        ));
    }

    #[test]
    fn a_fresh_stored_snapshot_is_served_with_its_age() {
        let fallback_called = Cell::new(false);
        let snapshot = collect_engineering_metrics_snapshot(
            30,
            now(),
            &data(Some(stored(
                "2026-06-10T11:00:00.000Z",
                json!({
                    "flakyRate": 0.01,
                    "asyncFailureSlaBreaches": 2,
                    "leadTimeMedianHours": 3.5
                }),
            ))),
            || {
                fallback_called.set(true);
                signals()
            },
        );
        assert!(
            !fallback_called.get(),
            "signals are not collected on the fresh path"
        );
        assert_eq!(snapshot.source, Some(SnapshotSource::Snapshot));
        assert_eq!(snapshot.is_fallback, Some(false));
        assert_eq!(snapshot.snapshot_age_hours, Some(1.0));
        assert_eq!(snapshot.flaky_rate, Some(0.01));
        assert_eq!(snapshot.async_failure_sla_breaches, 2);
        assert_eq!(snapshot.lead_time_median_hours, Some(3.5));
        // The payload has no criticalFailAutoReverts, so the computed count is used.
        assert_eq!(snapshot.critical_fail_auto_reverts, Some(4));
        let coverage = snapshot.domain_coverage.expect("coverage");
        assert_eq!(coverage.coverage_rate, Some(0.5));
        assert_eq!(coverage.uncovered_domains, vec!["b".to_string()]);
        assert_eq!(snapshot.rollout.expect("rollout").phase, None);
    }

    #[test]
    fn a_stale_snapshot_falls_back_to_the_signals() {
        let fallback_called = Cell::new(false);
        let snapshot = collect_engineering_metrics_snapshot(
            30,
            now(),
            &data(Some(stored("2026-06-08T00:00:00.000Z", json!({})))),
            || {
                fallback_called.set(true);
                signals()
            },
        );
        assert!(fallback_called.get());
        assert_eq!(snapshot.source, Some(SnapshotSource::Fallback));
        assert_eq!(snapshot.is_fallback, Some(true));
        assert_eq!(snapshot.first_pass_ci_rate, Some(1.0));
        assert_eq!(snapshot.snapshot_age_hours, Some(60.0));
        assert_eq!(snapshot.critical_fail_auto_reverts, Some(4));
    }

    #[test]
    fn no_stored_snapshot_is_a_fallback_without_age() {
        let snapshot = collect_engineering_metrics_snapshot(30, now(), &data(None), signals);
        assert_eq!(snapshot.source, Some(SnapshotSource::Fallback));
        assert_eq!(snapshot.snapshot_age_hours, None);
    }
}
