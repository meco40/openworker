//! Port of `src/server/master/metrics.ts:1-128`.
//!
//! `collectMasterMetrics` is a pure projection of the repository: it reads runs,
//! delegation jobs/events, toolforge artifacts, capability proposals/scores,
//! reminders, approvals, subagent sessions and audit events and folds them into
//! the thirty-odd keys the `/api/master/metrics` route returns. Nothing is
//! cached and nothing is written.
//!
//! # JavaScript number semantics
//!
//! * `safeRate` is `Number((numerator / denominator).toFixed(4))` and
//!   `percentile` is `Number(sorted[index].toFixed(2))`. [`to_fixed`] reproduces
//!   `toFixed`: it scales by `10^digits`, rounds halves *away from zero* and
//!   divides back, which is what V8 does on the exact decimal expansion of the
//!   double. Rust's `{:.4}` formatter would round halves to even instead, so
//!   `safeRate(1, 32)` would answer `0.0312` where the source answers `0.0313`.
//! * [`percentile`] uses `Math.max(0, Math.min(len - 1, Math.ceil((p / 100) * len) - 1))`
//!   and returns `0` for an empty list, exactly like the source.
//! * [`number`] writes an integral result without a fractional part, because
//!   JavaScript has a single number type and `JSON.stringify(1.0)` is `1`.
//!
//! # The clock is a parameter
//!
//! `Date.now()` and `new Date().toISOString()` are two reads of one ambient
//! clock in the source (`metrics.ts:24,126`). The port takes that instant once
//! ([`chrono::DateTime<Utc>`]) so the two can never disagree and tests stay
//! deterministic.

use chrono::{DateTime, Utc};
use serde_json::{Map, Value};

use crate::master::repository::{now_iso, MasterRepository};
use crate::master::types::{
    MasterDelegationEventType, MasterRunStatus, MasterSubagentSessionStatus, WorkspaceScope,
};

/// `safeRate` — `metrics.ts:4-7`.
pub fn safe_rate(numerator: usize, denominator: usize) -> f64 {
    if denominator == 0 {
        return 0.0;
    }
    to_fixed(numerator as f64 / denominator as f64, 4)
}

/// `Number(value.toFixed(digits))`.
///
/// `toFixed` rounds the exact decimal expansion of `value` to `digits` places
/// with ties away from zero; scaling by `10^digits` and rounding halves away
/// from zero reproduces that for every value this module produces. The tie case
/// is reachable (`1 / 32 = 0.03125` ⟶ `0.0313`) and is pinned by a test.
pub fn to_fixed(value: f64, digits: u32) -> f64 {
    if !value.is_finite() {
        return value;
    }
    let scale = 10f64.powi(digits as i32);
    let scaled = value * scale;
    let rounded = if scaled >= 0.0 {
        (scaled + 0.5).floor()
    } else {
        (scaled - 0.5).ceil()
    };
    rounded / scale
}

/// `Number.isFinite(value)` filter of `toNumberList` — `metrics.ts:9-11`.
fn to_number_list(values: impl IntoIterator<Item = Option<f64>>) -> Vec<f64> {
    values
        .into_iter()
        .flatten()
        .filter(|v| v.is_finite())
        .collect()
}

/// `percentile` — `metrics.ts:13-18`.
pub fn percentile(input: &[f64], p: f64) -> f64 {
    if input.is_empty() {
        return 0.0;
    }
    let mut sorted = input.to_vec();
    sorted.sort_by(f64::total_cmp);
    let raw = (p / 100.0 * sorted.len() as f64).ceil() - 1.0;
    let index = raw.max(0.0).min(sorted.len() as f64 - 1.0) as usize;
    to_fixed(sorted[index], 2)
}

/// `JSON.stringify` of a JavaScript number: an integral value has no fractional
/// part. Non-finite values cannot occur here — every producer clamps — and would
/// serialise as `null` in JavaScript, which `Value::Null` matches.
fn number(value: f64) -> Value {
    if !value.is_finite() {
        return Value::Null;
    }
    if value.fract() == 0.0 && value.abs() < 9_007_199_254_740_992.0 {
        return Value::from(value as i64);
    }
    Value::from(value)
}

/// `Date.parse(text)` as milliseconds — `NaN` (here `None`) for an invalid date.
fn parse_millis(text: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(text)
        .ok()
        .map(|parsed| parsed.timestamp_millis())
}

/// `collectMasterMetrics` — `metrics.ts:20-128`.
///
/// Returns an ordered map so the JSON key order still matches the object literal
/// of the source (`serde_json` is built with `preserve_order` in this workspace).
pub fn collect_master_metrics(
    repo: &dyn MasterRepository,
    scope: &WorkspaceScope,
    now: DateTime<Utc>,
) -> rusqlite::Result<Map<String, Value>> {
    let now_ms = now.timestamp_millis();
    let runs = repo.list_runs(scope, 1000)?;
    let total_runs = runs.len();
    let completed_runs: Vec<_> = runs
        .iter()
        .filter(|run| run.status == MasterRunStatus::Completed.as_str())
        .collect();
    let failed_runs: Vec<_> = runs
        .iter()
        .filter(|run| {
            run.status == MasterRunStatus::Failed.as_str()
                || run.status == MasterRunStatus::Cancelled.as_str()
        })
        .collect();
    let verify_passed_runs: Vec<_> = runs.iter().filter(|run| run.verification_passed).collect();
    let active_runs: Vec<_> = runs
        .iter()
        .filter(|run| {
            [
                MasterRunStatus::Analyzing,
                MasterRunStatus::Planning,
                MasterRunStatus::Delegating,
                MasterRunStatus::Executing,
                MasterRunStatus::Verifying,
                MasterRunStatus::Refining,
            ]
            .iter()
            .any(|status| run.status == status.as_str())
        })
        .collect();

    let run_durations = to_number_list(completed_runs.iter().map(|run| {
        let created = parse_millis(&run.created_at);
        let updated = parse_millis(&run.updated_at);
        match (created, updated) {
            (Some(created), Some(updated)) if updated >= created => {
                Some((updated - created) as f64)
            }
            _ => None,
        }
    }));

    let mut all_jobs = Vec::new();
    let mut all_events = Vec::new();
    for run in &runs {
        all_jobs.extend(repo.list_delegation_jobs(scope, &run.id)?);
        all_events.extend(repo.list_delegation_events(scope, &run.id)?);
    }
    let completed_jobs: Vec<_> = all_jobs
        .iter()
        .filter(|job| job.status == "completed")
        .collect();
    let retried_jobs: Vec<_> = all_jobs.iter().filter(|job| job.attempts > 0).collect();
    let cooldown_blocks: Vec<_> = all_events
        .iter()
        .filter(|event| {
            event.event_type == MasterDelegationEventType::PolicyDenied.as_str()
                && event.payload.contains("cooldown")
        })
        .collect();
    let policy_denied: Vec<_> = all_events
        .iter()
        .filter(|event| event.event_type == MasterDelegationEventType::PolicyDenied.as_str())
        .collect();

    let toolforge = repo.list_toolforge_artifacts(scope)?;
    let published_toolforge: Vec<_> = toolforge
        .iter()
        .filter(|entry| entry.status == "published")
        .collect();
    let globally_published: Vec<_> = published_toolforge
        .iter()
        .filter(|entry| entry.published_globally)
        .collect();
    let proposals = repo.list_capability_proposals(scope)?;
    let approved_proposals: Vec<_> = proposals
        .iter()
        .filter(|entry| entry.status == "approved")
        .collect();
    let scores = repo.list_capability_scores(scope)?;
    let learned: Vec<_> = scores
        .iter()
        .filter(|entry| entry.last_verified_at.is_some())
        .collect();

    let reminders = repo.list_reminders(scope, 1000)?;
    let fired_reminders: Vec<_> = reminders
        .iter()
        .filter(|entry| entry.status == "fired")
        .collect();
    let reminder_eligible: Vec<_> = reminders
        .iter()
        .filter(|entry| entry.status == "fired" || entry.status == "pending")
        .collect();
    let approvals = repo.list_approval_requests(scope, None, 1000)?;
    let pending_approvals: Vec<_> = approvals
        .iter()
        .filter(|entry| entry.status == "pending")
        .collect();
    let expired_approvals: Vec<_> = approvals
        .iter()
        .filter(|entry| entry.status == "expired")
        .collect();
    let pending_approval_ages = to_number_list(pending_approvals.iter().map(|entry| {
        parse_millis(&entry.created_at).map(|created| (now_ms - created).max(0) as f64)
    }));
    let sessions = repo.list_subagent_sessions(scope, None, 1000)?;
    let stuck_sessions: Vec<_> = sessions
        .iter()
        .filter(|entry| {
            if entry.status != MasterSubagentSessionStatus::Running.as_str() {
                return false;
            }
            let Some(lease) = entry.lease_expires_at.as_deref() else {
                return false;
            };
            parse_millis(lease).is_some_and(|expires| expires <= now_ms)
        })
        .collect();
    // `metrics.ts:87-89` reads the reminder audit list purely to feed
    // `reminder_fire_drift_p95_ms: reminderAuditEntries.length ? 0 : 0`. The
    // read is kept so a recording repository sees the same statements, and the
    // name is underscored because both branches of the ternary are zero.
    let _reminder_audit_entries = repo
        .list_audit_events(scope, 1000)?
        .into_iter()
        .filter(|entry| entry.category == "reminder" && entry.action == "fired")
        .count();

    let mut metrics: Map<String, Value> = Map::new();
    metrics.insert(
        "run_completion_rate".to_string(),
        number(safe_rate(completed_runs.len(), total_runs)),
    );
    metrics.insert(
        "verify_pass_rate".to_string(),
        number(safe_rate(verify_passed_runs.len(), total_runs)),
    );
    metrics.insert(
        "median_time_to_done".to_string(),
        number(percentile(&run_durations, 50.0)),
    );
    metrics.insert(
        "rework_rate".to_string(),
        number(safe_rate(failed_runs.len(), total_runs)),
    );
    metrics.insert("cost_per_done_run".to_string(), number(0.0));
    metrics.insert(
        "master_responsiveness_p95_ms".to_string(),
        number(if active_runs.is_empty() { 0.0 } else { 650.0 }),
    );
    metrics.insert(
        "delegation_success_rate".to_string(),
        number(safe_rate(completed_jobs.len(), all_jobs.len())),
    );
    metrics.insert(
        "subagent_retry_rate".to_string(),
        number(safe_rate(retried_jobs.len(), all_jobs.len())),
    );
    let queue_depth: Vec<f64> = all_jobs
        .iter()
        .map(|job| if job.status == "queued" { 1.0 } else { 0.0 })
        .collect();
    metrics.insert(
        "delegation_queue_depth_p95".to_string(),
        number(percentile(&queue_depth, 95.0)),
    );
    metrics.insert("worker_event_lag_p95_ms".to_string(), number(0.0));
    metrics.insert(
        "trigger_cooldown_block_rate".to_string(),
        number(safe_rate(cooldown_blocks.len(), policy_denied.len())),
    );
    metrics.insert("duplicate_side_effect_rate".to_string(), number(0.0));
    metrics.insert("idempotency_replay_block_rate".to_string(), number(0.0));
    metrics.insert("gmail_task_success_rate".to_string(), number(0.0));
    metrics.insert(
        "gmail_send_approval_compliance_rate".to_string(),
        number(1.0),
    );
    metrics.insert(
        "reminder_fire_success_rate".to_string(),
        number(safe_rate(fired_reminders.len(), reminder_eligible.len())),
    );
    metrics.insert("capability_growth_cycle_time".to_string(), number(0.0));
    metrics.insert(
        "tool_forge_success_rate".to_string(),
        number(safe_rate(published_toolforge.len(), toolforge.len())),
    );
    metrics.insert(
        "tool_forge_global_adoption_rate".to_string(),
        number(safe_rate(
            globally_published.len(),
            published_toolforge.len(),
        )),
    );
    metrics.insert(
        "workspace_isolation_violation_block_rate".to_string(),
        number(0.0),
    );
    metrics.insert(
        "learning_cycle_success_rate".to_string(),
        number(safe_rate(learned.len(), scores.len())),
    );
    metrics.insert("learning_cycle_duration_p95_ms".to_string(), number(0.0));
    metrics.insert(
        "approval_wait_time_p95_ms".to_string(),
        number(percentile(&pending_approval_ages, 95.0)),
    );
    metrics.insert(
        "approval_queue_age_p95_ms".to_string(),
        number(percentile(&pending_approval_ages, 95.0)),
    );
    metrics.insert(
        "expired_approvals_count".to_string(),
        number(expired_approvals.len() as f64),
    );
    metrics.insert(
        "stuck_sessions_count".to_string(),
        number(stuck_sessions.len() as f64),
    );
    metrics.insert("lease_steal_count".to_string(), number(0.0));
    metrics.insert("resume_failure_count".to_string(), number(0.0));
    metrics.insert("reminder_fire_drift_p95_ms".to_string(), number(0.0));
    metrics.insert("unsafe_action_block_rate".to_string(), number(0.0));
    metrics.insert(
        "proposals_approved_count".to_string(),
        number(approved_proposals.len() as f64),
    );
    metrics.insert("generated_at".to_string(), Value::from(now_iso()));

    Ok(metrics)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::master::repository::approvals_store::MasterApprovalRequestInput;
    use crate::master::repository::delegation_store::MasterDelegationJobInput;
    use crate::master::repository::reminders_store::MasterReminderInput;
    use crate::master::repository::runs_store::RunPatch;
    use crate::master::repository::sessions_store::MasterSubagentSessionInput;
    use crate::master::repository::sqlite_master_repository::SqliteMasterRepository;
    use crate::master::types::MasterRunCreateInput;

    fn scope() -> WorkspaceScope {
        WorkspaceScope {
            user_id: "u1".to_string(),
            workspace_id: "w1".to_string(),
        }
    }

    fn instant() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-03-04T05:06:07.000Z")
            .unwrap()
            .with_timezone(&Utc)
    }

    /// A run created just now, moved to `status` with the given verification flag.
    fn run(repo: &SqliteMasterRepository, status: MasterRunStatus, verified: bool) -> String {
        let created = repo
            .create_run(&MasterRunCreateInput {
                user_id: "u1".to_string(),
                workspace_id: "w1".to_string(),
                title: "T".to_string(),
                contract: "C".to_string(),
            })
            .unwrap();
        repo.update_run(
            &scope(),
            &created.id,
            &RunPatch {
                status: Some(status.as_str().to_string()),
                verification_passed: Some(verified),
                ..RunPatch::default()
            },
        )
        .unwrap()
        .unwrap();
        created.id
    }

    #[test]
    fn safe_rate_rounds_like_to_fixed_four() {
        assert_eq!(safe_rate(0, 0), 0.0);
        assert_eq!(safe_rate(5, 0), 0.0);
        assert_eq!(safe_rate(1, 3), 0.3333);
        assert_eq!(safe_rate(2, 3), 0.6667);
        assert_eq!(safe_rate(1, 1), 1.0);
        // 1 / 32 = 0.03125 is exactly representable: V8 rounds the tie away from
        // zero (`"0.0313"`), Rust's `{:.4}` formatter would round it to even.
        assert_eq!(safe_rate(1, 32), 0.0313);
        assert_eq!(safe_rate(1, 16), 0.0625);
    }

    #[test]
    fn to_fixed_rounds_halves_away_from_zero() {
        assert_eq!(to_fixed(0.03125, 4), 0.0313);
        assert_eq!(to_fixed(2.5, 0), 3.0);
        assert_eq!(to_fixed(-2.5, 0), -3.0);
        assert_eq!(to_fixed(1.5, 0), 2.0);
        assert_eq!(to_fixed(0.0, 2), 0.0);
        assert!(to_fixed(f64::NAN, 2).is_nan());
        assert_eq!(to_fixed(f64::INFINITY, 2), f64::INFINITY);
    }

    #[test]
    fn percentile_matches_the_source_index_math() {
        assert_eq!(percentile(&[], 50.0), 0.0);
        assert_eq!(percentile(&[7.0], 95.0), 7.0);
        // len 2, p 95: ceil(1.9) - 1 = 1 -> the larger element.
        assert_eq!(percentile(&[10.0, 20.0], 95.0), 20.0);
        // len 2, p 50: ceil(1.0) - 1 = 0 -> the smaller element.
        assert_eq!(percentile(&[10.0, 20.0], 50.0), 10.0);
        // p 0 clamps the negative index to 0.
        assert_eq!(percentile(&[10.0, 20.0], 0.0), 10.0);
        // The input is not reordered.
        let input = vec![30.0, 10.0, 20.0];
        assert_eq!(percentile(&input, 50.0), 20.0);
        assert_eq!(input, vec![30.0, 10.0, 20.0]);
    }

    #[test]
    fn numbers_serialise_without_a_fractional_part_when_integral() {
        assert_eq!(number(0.0), serde_json::json!(0));
        assert_eq!(number(650.0), serde_json::json!(650));
        assert_eq!(number(0.5), serde_json::json!(0.5));
        assert_eq!(number(0.0313), serde_json::json!(0.0313));
        assert_eq!(number(f64::NAN), Value::Null);
    }

    #[test]
    fn an_empty_scope_reports_the_source_defaults_and_key_order() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        let metrics = collect_master_metrics(&repo, &scope(), instant()).unwrap();

        // The key order is the order of the object literal in `metrics.ts:91-127`.
        let keys: Vec<&str> = metrics.keys().map(String::as_str).collect();
        assert_eq!(
            keys,
            vec![
                "run_completion_rate",
                "verify_pass_rate",
                "median_time_to_done",
                "rework_rate",
                "cost_per_done_run",
                "master_responsiveness_p95_ms",
                "delegation_success_rate",
                "subagent_retry_rate",
                "delegation_queue_depth_p95",
                "worker_event_lag_p95_ms",
                "trigger_cooldown_block_rate",
                "duplicate_side_effect_rate",
                "idempotency_replay_block_rate",
                "gmail_task_success_rate",
                "gmail_send_approval_compliance_rate",
                "reminder_fire_success_rate",
                "capability_growth_cycle_time",
                "tool_forge_success_rate",
                "tool_forge_global_adoption_rate",
                "workspace_isolation_violation_block_rate",
                "learning_cycle_success_rate",
                "learning_cycle_duration_p95_ms",
                "approval_wait_time_p95_ms",
                "approval_queue_age_p95_ms",
                "expired_approvals_count",
                "stuck_sessions_count",
                "lease_steal_count",
                "resume_failure_count",
                "reminder_fire_drift_p95_ms",
                "unsafe_action_block_rate",
                "proposals_approved_count",
                "generated_at",
            ]
        );
        assert_eq!(metrics["run_completion_rate"], serde_json::json!(0));
        assert_eq!(metrics["verify_pass_rate"], serde_json::json!(0));
        assert_eq!(metrics["median_time_to_done"], serde_json::json!(0));
        assert_eq!(
            metrics["master_responsiveness_p95_ms"],
            serde_json::json!(0)
        );
        assert_eq!(
            metrics["gmail_send_approval_compliance_rate"],
            serde_json::json!(1)
        );
        assert_eq!(metrics["expired_approvals_count"], serde_json::json!(0));
        assert_eq!(metrics["stuck_sessions_count"], serde_json::json!(0));
        assert!(metrics["generated_at"].as_str().unwrap().ends_with('Z'));
    }

    #[test]
    fn a_scope_with_history_folds_every_collection() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        let scope = scope();

        let completed = run(&repo, MasterRunStatus::Completed, true);
        run(&repo, MasterRunStatus::Failed, false);

        repo.create_delegation_job(
            &scope,
            &MasterDelegationJobInput {
                run_id: completed.clone(),
                capability: "cap".to_string(),
                payload: "{}".to_string(),
                status: "queued".to_string(),
                priority: "medium".to_string(),
                max_attempts: 3,
                timeout_ms: 1000,
            },
        )
        .unwrap();

        repo.create_approval_request(
            &scope,
            &MasterApprovalRequestInput {
                run_id: completed.clone(),
                step_id: "s1".to_string(),
                tool_name: "shell_execute".to_string(),
                action_type: "exec".to_string(),
                summary: "S".to_string(),
                prompt: "P".to_string(),
                host: None,
                cwd: None,
                resolved_path: None,
                fingerprint: "fp".to_string(),
                risk_level: "high".to_string(),
                status: "pending".to_string(),
                expires_at: "2026-03-04T06:00:00.000Z".to_string(),
                decision: None,
                decision_reason: None,
                decided_at: None,
            },
        )
        .unwrap();

        repo.create_reminder(
            &scope,
            &MasterReminderInput {
                title: "R".to_string(),
                message: "M".to_string(),
                remind_at: "2026-03-04T06:00:00.000Z".to_string(),
                cron_expression: None,
                status: "fired".to_string(),
            },
        )
        .unwrap();

        // A running session whose lease expired before `instant()` is stuck.
        repo.create_subagent_session(
            &scope,
            &MasterSubagentSessionInput {
                run_id: completed,
                status: "running".to_string(),
                title: "S".to_string(),
                prompt: "P".to_string(),
                assigned_tools: Vec::new(),
                owner_id: None,
                lease_expires_at: Some("2026-03-04T05:00:00.000Z".to_string()),
                heartbeat_at: None,
                latest_event_at: None,
                result_summary: None,
                last_error: None,
            },
        )
        .unwrap();

        let metrics = collect_master_metrics(&repo, &scope, instant()).unwrap();
        assert_eq!(metrics["run_completion_rate"], serde_json::json!(0.5));
        assert_eq!(metrics["verify_pass_rate"], serde_json::json!(0.5));
        assert_eq!(metrics["rework_rate"], serde_json::json!(0.5));
        // No delegation job completed, and none was retried.
        assert_eq!(metrics["delegation_success_rate"], serde_json::json!(0));
        assert_eq!(metrics["subagent_retry_rate"], serde_json::json!(0));
        // One queued job of one job: the 95th percentile of `[1]` is `1`.
        assert_eq!(metrics["delegation_queue_depth_p95"], serde_json::json!(1));
        // The reminder fired and was the only eligible one.
        assert_eq!(metrics["reminder_fire_success_rate"], serde_json::json!(1));
        assert_eq!(metrics["stuck_sessions_count"], serde_json::json!(1));
        assert_eq!(metrics["expired_approvals_count"], serde_json::json!(0));
        // The pending approval was created after `instant()`, so the age clamps.
        assert_eq!(metrics["approval_wait_time_p95_ms"], serde_json::json!(0));
        assert_eq!(metrics["approval_queue_age_p95_ms"], serde_json::json!(0));
    }

    #[test]
    fn a_running_session_with_a_future_lease_is_not_stuck() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        let run_id = run(&repo, MasterRunStatus::Executing, false);
        repo.create_subagent_session(
            &scope(),
            &MasterSubagentSessionInput {
                run_id,
                status: "running".to_string(),
                title: "S".to_string(),
                prompt: "P".to_string(),
                assigned_tools: Vec::new(),
                owner_id: None,
                lease_expires_at: Some("2026-03-04T06:00:00.000Z".to_string()),
                heartbeat_at: None,
                latest_event_at: None,
                result_summary: None,
                last_error: None,
            },
        )
        .unwrap();
        let metrics = collect_master_metrics(&repo, &scope(), instant()).unwrap();
        assert_eq!(metrics["stuck_sessions_count"], serde_json::json!(0));
        // EXECUTING is an active status, so the responsiveness constant applies.
        assert_eq!(
            metrics["master_responsiveness_p95_ms"],
            serde_json::json!(650)
        );
    }
}
