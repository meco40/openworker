//! Port of `src/server/master/runtime.ts:1-142`.
//!
//! The Master maintenance tick and the process-wide Master handles it drives:
//! once per day and per scope, [`run_master_maintenance_tick`] runs the learning
//! loop unless the scope already ran today or still has an active run.
//!
//! # Process-wide globals have no Rust counterpart
//!
//! `runtime.ts:7-18` declares five `globalThis.__master*` slots. `betaclaw-core`
//! has no such store, so:
//!
//! * `__masterRepository` and `__masterMaintenanceLastRunByScope` become fields
//!   of [`MasterRuntime`] — one instance per process, created by the gateway,
//!   which is the same lifetime the globals have.
//! * `__masterOrchestrator` and `__masterExecutionRuntime` are typed by the
//!   `MasterOrchestrator` of P3/P4 ports and by `MasterExecutionRuntime`
//!   (`execution/runtime/masterExecutionRuntime.ts`, package P4). They are
//!   therefore *not* part of this port — see OP-S9-7; the gateway composes them
//!   once both packages have landed.
//! * `__masterMaintenanceInterval` is the `setInterval(…, 60_000)` of
//!   `runtime.ts:125-131`, a process-wide timer. It is the
//!   [`MasterMaintenanceScheduler`] seam, whose default
//!   ([`NoopMasterMaintenanceScheduler`]) only logs — the same fire-and-forget
//!   treatment [`crate::master::live_events`] gives the event bus.
//!
//! `resetMasterRepositoryForTests` (`runtime.ts:28-42`) also awaits the execution
//! runtime before dropping the globals; [`MasterRuntime::reset`] covers the
//! repository, the tracker and the scheduler, and its documentation says so.

use std::collections::HashMap;

use chrono::{DateTime, Datelike, Local, Utc};

use crate::master::learning::{run_daily_learning_loop, CapabilityUnderstandingCycle};
use crate::master::repository::sqlite_master_repository::SqliteMasterRepository;
use crate::master::repository::MasterRepository;
use crate::master::types::{MasterRunStatus, WorkspaceScope};

/// `setInterval(…, 60_000)` — `runtime.ts:129`.
pub const MASTER_MAINTENANCE_INTERVAL_MS: u64 = 60_000;

/// `listKnownScopes` default from `scopes.store.ts:6` (`limit = 500`).
///
/// `runtime.ts:82` calls it without a limit.
pub const DEFAULT_KNOWN_SCOPE_LIMIT: i64 = 500;

/// The `200` of `runtime.ts:93` (`listRuns(scope, 200)`).
pub const MAINTENANCE_RUN_SCAN_LIMIT: i64 = 200;

/// The seven statuses that count as "the scope is busy" — `runtime.ts:95-103`.
///
/// `AWAITING_APPROVAL` is included here although the metrics list of
/// `metrics.ts:30-34` stops before it; the two lists are not the same and are
/// ported as written.
pub const ACTIVE_RUN_STATUSES: &[MasterRunStatus] = &[
    MasterRunStatus::Analyzing,
    MasterRunStatus::Planning,
    MasterRunStatus::Delegating,
    MasterRunStatus::Executing,
    MasterRunStatus::Verifying,
    MasterRunStatus::Refining,
    MasterRunStatus::AwaitingApproval,
];

/// `{ executedScopes, skippedScopes, dateKey }` — `runtime.ts:79`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MaintenanceTickResult {
    pub executed_scopes: usize,
    pub skipped_scopes: usize,
    pub date_key: String,
}

/// `globalThis.__masterMaintenanceLastRunByScope` — `runtime.ts:17`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MasterMaintenanceTracker {
    last_run_by_scope: HashMap<String, String>,
}

impl MasterMaintenanceTracker {
    pub fn new() -> Self {
        Self::default()
    }

    /// `tracker.get(scopeKey)` — `runtime.ts:88`.
    pub fn get(&self, scope_key: &str) -> Option<&str> {
        self.last_run_by_scope.get(scope_key).map(String::as_str)
    }

    /// `tracker.set(scopeKey, dateKey)` — `runtime.ts:111`.
    pub fn set(&mut self, scope_key: &str, date_key: &str) {
        self.last_run_by_scope
            .insert(scope_key.to_string(), date_key.to_string());
    }

    /// `tracker.clear()` — `runtime.ts:140`.
    pub fn clear(&mut self) {
        self.last_run_by_scope.clear();
    }

    pub fn len(&self) -> usize {
        self.last_run_by_scope.len()
    }

    pub fn is_empty(&self) -> bool {
        self.last_run_by_scope.is_empty()
    }
}

/// `currentDayKey` — `runtime.ts:61-63`.
///
/// `getUTCFullYear()`/`getUTCMonth()`/`getUTCDate()` with two-digit padding, so
/// `2026-03-04`.
pub fn current_day_key(now: DateTime<Utc>) -> String {
    format!("{}-{:02}-{:02}", now.year(), now.month(), now.day())
}

/// `buildScopeKey` — `runtime.ts:72-74`.
pub fn build_scope_key(scope: &WorkspaceScope) -> String {
    format!("{}::{}", scope.user_id, scope.workspace_id)
}

/// `setInterval(() => { void runMasterMaintenanceTick(…) }, 60_000)` —
/// `runtime.ts:125-131`, plus the `clearInterval` of `:135-137`.
///
/// The TypeScript timer swallows every error of the tick
/// (`runtime.ts:126-128`), which an implementation of this seam must preserve.
pub trait MasterMaintenanceScheduler: Send + Sync {
    /// `ensureMasterMaintenanceScheduler()` — `runtime.ts:121-132`.
    fn ensure(&self);
    /// `stopMasterMaintenanceScheduler()` — `runtime.ts:134-138`
    /// (the interval only; clearing the tracker is [`MasterRuntime::reset`]).
    fn stop(&self);
}

/// The default: log and continue. No timer runs until the gateway injects one,
/// which is the same deliberate reduction as the no-op event bus publisher.
#[derive(Debug, Clone, Copy, Default)]
pub struct NoopMasterMaintenanceScheduler;

impl MasterMaintenanceScheduler for NoopMasterMaintenanceScheduler {
    fn ensure(&self) {
        tracing::debug!(
            interval_ms = MASTER_MAINTENANCE_INTERVAL_MS,
            "master maintenance scheduler requested (no timer in betaclaw-core)"
        );
    }

    fn stop(&self) {
        tracing::debug!("master maintenance scheduler stop requested");
    }
}

/// `runMasterMaintenanceTick` — `runtime.ts:76-119`.
///
/// `now` is the single instant the source reads twice: `currentDayKey` uses its
/// UTC date, the learning loop uses its local date for `scheduledAt`.
pub fn run_master_maintenance_tick(
    cycle: &dyn CapabilityUnderstandingCycle,
    repo: &dyn MasterRepository,
    tracker: &mut MasterMaintenanceTracker,
    now: DateTime<Local>,
) -> rusqlite::Result<MaintenanceTickResult> {
    let date_key = current_day_key(now.with_timezone(&Utc));
    let scopes = repo.list_known_scopes(DEFAULT_KNOWN_SCOPE_LIMIT)?;

    let mut executed_scopes = 0usize;
    let mut skipped_scopes = 0usize;
    for scope in scopes {
        let scope_key = build_scope_key(&scope);
        if tracker.get(&scope_key) == Some(date_key.as_str()) {
            skipped_scopes += 1;
            continue;
        }
        let has_active_runs = repo
            .list_runs(&scope, MAINTENANCE_RUN_SCAN_LIMIT)?
            .iter()
            .any(|run| {
                ACTIVE_RUN_STATUSES
                    .iter()
                    .any(|status| run.status == status.as_str())
            });
        if has_active_runs {
            skipped_scopes += 1;
            continue;
        }
        let cycle_result = run_daily_learning_loop(cycle, repo, &scope, now)?;
        if cycle_result.executed {
            tracker.set(&scope_key, &date_key);
            executed_scopes += 1;
        } else {
            skipped_scopes += 1;
        }
    }

    Ok(MaintenanceTickResult {
        executed_scopes,
        skipped_scopes,
        date_key,
    })
}

/// `globalThis.__masterRepository`, `__masterMaintenanceLastRunByScope` and
/// `__masterMaintenanceInterval` — `runtime.ts:7-18,20-26,28-42`.
///
/// One instance per process. `getMasterOrchestrator` (`:44-49`) and
/// `getMasterExecutionRuntime` (`:51-59`) are deferred to OP-S9-7 because their
/// types live in P3/P4.
pub struct MasterRuntime {
    repository: Option<SqliteMasterRepository>,
    tracker: MasterMaintenanceTracker,
    scheduler: Box<dyn MasterMaintenanceScheduler>,
}

impl Default for MasterRuntime {
    fn default() -> Self {
        Self {
            repository: None,
            tracker: MasterMaintenanceTracker::new(),
            scheduler: Box::new(NoopMasterMaintenanceScheduler),
        }
    }
}

impl MasterRuntime {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_scheduler(scheduler: Box<dyn MasterMaintenanceScheduler>) -> Self {
        Self {
            scheduler,
            ..Self::default()
        }
    }

    /// `getMasterRepository()` — `runtime.ts:20-26`.
    ///
    /// The repository is created from `MASTER_DB_PATH || '.local/master.db'`
    /// ([`SqliteMasterRepository::open_default`]) and the maintenance scheduler
    /// is started right after, in the order of the source.
    pub fn repository(&mut self) -> rusqlite::Result<&SqliteMasterRepository> {
        if self.repository.is_none() {
            self.repository = Some(SqliteMasterRepository::open_default()?);
            self.scheduler.ensure();
        }
        Ok(self
            .repository
            .as_ref()
            .expect("the repository was just created"))
    }

    /// `globalThis.__masterRepository = new SqliteMasterRepository()` —
    /// `runtime.ts:22`.
    ///
    /// The source assigns the global inline inside `getMasterRepository`; the
    /// port exposes the same assignment so a caller with an already configured
    /// handle — the gateway, or a test — does not have to go through
    /// `MASTER_DB_PATH`. The scheduler is started right after, like in the
    /// source.
    pub fn set_repository(&mut self, repository: SqliteMasterRepository) {
        self.repository = Some(repository);
        self.scheduler.ensure();
    }

    /// The repository if one was opened, without opening one.
    pub fn repository_if_open(&self) -> Option<&SqliteMasterRepository> {
        self.repository.as_ref()
    }

    /// `globalThis.__masterMaintenanceLastRunByScope`.
    pub fn tracker(&mut self) -> &mut MasterMaintenanceTracker {
        &mut self.tracker
    }

    /// `resetMasterRepositoryForTests` — `runtime.ts:28-42`.
    ///
    /// Stops the scheduler, clears the tracker and drops the repository. The
    /// `await executionRuntime.waitForAllRuns()` of `:31-34` drains the P4
    /// execution-runtime global, which this port does not own: the caller drains
    /// it before calling `reset`.
    pub fn reset(&mut self) {
        self.scheduler.stop();
        self.tracker.clear();
        self.repository = None;
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use chrono::{TimeZone, Timelike};

    use super::*;
    use crate::master::learning::CapabilityUnderstandingCycleOutcome;
    use crate::master::repository::runs_store::RunPatch;
    use crate::master::types::MasterRunCreateInput;

    fn at(year: i32, month: u32, day: u32, hour: u32, minute: u32) -> DateTime<Local> {
        Local
            .with_ymd_and_hms(year, month, day, hour, minute, 0)
            .single()
            .expect("unambiguous local timestamp")
    }

    fn scope() -> WorkspaceScope {
        WorkspaceScope {
            user_id: "u1".to_string(),
            workspace_id: "w1".to_string(),
        }
    }

    /// A repository with exactly one known scope and no active run.
    fn repo_with_scope() -> SqliteMasterRepository {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        // `createRun` starts in ANALYZING, which is an active status; the scope
        // must be idle for the tick to reach the cycle.
        let run = repo
            .create_run(&MasterRunCreateInput {
                user_id: "u1".to_string(),
                workspace_id: "w1".to_string(),
                title: "T".to_string(),
                contract: "C".to_string(),
            })
            .unwrap();
        repo.update_run(
            &scope(),
            &run.id,
            &RunPatch {
                status: Some(MasterRunStatus::Completed.as_str().to_string()),
                ..RunPatch::default()
            },
        )
        .unwrap();
        repo
    }

    /// The id of the newest run of the test scope — the one still active.
    fn active_run(repo: &SqliteMasterRepository) -> String {
        repo.create_run(&MasterRunCreateInput {
            user_id: "u1".to_string(),
            workspace_id: "w1".to_string(),
            title: "T2".to_string(),
            contract: "C2".to_string(),
        })
        .unwrap()
        .id
    }

    #[derive(Default)]
    struct FakeCycle {
        executed: bool,
        calls: Mutex<Vec<String>>,
    }

    impl CapabilityUnderstandingCycle for FakeCycle {
        fn should_run_learning_cycle_at(&self, date: DateTime<Utc>) -> bool {
            date.hour() == 3 && date.minute() == 0
        }

        fn run_capability_understanding_cycle(
            &self,
            repo: &dyn MasterRepository,
            scope: &WorkspaceScope,
            _now: DateTime<Local>,
        ) -> rusqlite::Result<CapabilityUnderstandingCycleOutcome> {
            repo.list_capability_scores(scope)?;
            self.calls.lock().unwrap().push(build_scope_key(scope));
            Ok(CapabilityUnderstandingCycleOutcome {
                updated: 0,
                executed: self.executed,
            })
        }
    }

    #[derive(Default)]
    struct RecordingScheduler {
        calls: Mutex<Vec<&'static str>>,
    }

    impl MasterMaintenanceScheduler for RecordingScheduler {
        fn ensure(&self) {
            self.calls.lock().unwrap().push("ensure");
        }
        fn stop(&self) {
            self.calls.lock().unwrap().push("stop");
        }
    }

    #[test]
    fn the_day_key_and_the_scope_key_mirror_the_source() {
        // 23:30 UTC on the 4th is still the 4th.
        let late = DateTime::parse_from_rfc3339("2026-03-04T23:30:00.000Z")
            .unwrap()
            .with_timezone(&Utc);
        assert_eq!(current_day_key(late), "2026-03-04");
        let padded = DateTime::parse_from_rfc3339("2026-01-09T00:00:00.000Z")
            .unwrap()
            .with_timezone(&Utc);
        assert_eq!(current_day_key(padded), "2026-01-09");
        assert_eq!(build_scope_key(&scope()), "u1::w1");
    }

    #[test]
    fn a_tick_runs_the_cycle_and_remembers_the_day() {
        let repo = repo_with_scope();
        let cycle = FakeCycle {
            executed: true,
            ..FakeCycle::default()
        };
        let mut tracker = MasterMaintenanceTracker::new();
        let now = at(2026, 3, 4, 5, 6);

        let first = run_master_maintenance_tick(&cycle, &repo, &mut tracker, now).unwrap();
        assert_eq!(first.executed_scopes, 1);
        assert_eq!(first.skipped_scopes, 0);
        assert_eq!(first.date_key, "2026-03-04");
        assert_eq!(tracker.len(), 1);
        assert_eq!(tracker.get("u1::w1"), Some("2026-03-04"));

        // The second tick on the same UTC day skips the scope without a cycle.
        let second = run_master_maintenance_tick(&cycle, &repo, &mut tracker, now).unwrap();
        assert_eq!(second.executed_scopes, 0);
        assert_eq!(second.skipped_scopes, 1);
        assert_eq!(cycle.calls.lock().unwrap().len(), 1);
    }

    #[test]
    fn a_cycle_that_did_not_execute_leaves_the_tracker_empty() {
        let repo = repo_with_scope();
        let cycle = FakeCycle::default();
        let mut tracker = MasterMaintenanceTracker::new();

        let result =
            run_master_maintenance_tick(&cycle, &repo, &mut tracker, at(2026, 3, 4, 0, 0)).unwrap();
        assert_eq!(result.executed_scopes, 0);
        assert_eq!(result.skipped_scopes, 1);
        assert!(tracker.is_empty());
        // The cycle was still asked.
        assert_eq!(cycle.calls.lock().unwrap().len(), 1);
    }

    #[test]
    fn an_active_run_skips_the_scope_even_on_a_new_day() {
        let repo = repo_with_scope();
        let cycle = FakeCycle {
            executed: true,
            ..FakeCycle::default()
        };
        let mut tracker = MasterMaintenanceTracker::new();

        // A fresh run is ANALYZING, which is an active status.
        let run_id = active_run(&repo);
        let result =
            run_master_maintenance_tick(&cycle, &repo, &mut tracker, at(2026, 3, 4, 9, 0)).unwrap();
        assert_eq!(result.executed_scopes, 0);
        assert_eq!(result.skipped_scopes, 1);
        assert!(cycle.calls.lock().unwrap().is_empty());
        assert!(tracker.is_empty());

        // AWAITING_APPROVAL is in the maintenance list as well.
        repo.update_run(
            &scope(),
            &run_id,
            &RunPatch {
                status: Some(MasterRunStatus::AwaitingApproval.as_str().to_string()),
                ..RunPatch::default()
            },
        )
        .unwrap();
        let result =
            run_master_maintenance_tick(&cycle, &repo, &mut tracker, at(2026, 3, 4, 9, 0)).unwrap();
        assert_eq!(result.skipped_scopes, 1);
        assert!(cycle.calls.lock().unwrap().is_empty());

        // A terminal status no longer blocks the scope.
        repo.update_run(
            &scope(),
            &run_id,
            &RunPatch {
                status: Some(MasterRunStatus::Completed.as_str().to_string()),
                ..RunPatch::default()
            },
        )
        .unwrap();
        let result =
            run_master_maintenance_tick(&cycle, &repo, &mut tracker, at(2026, 3, 4, 9, 0)).unwrap();
        assert_eq!(result.executed_scopes, 1);
        assert_eq!(cycle.calls.lock().unwrap().len(), 1);
    }

    #[test]
    fn the_runtime_starts_the_scheduler_once_and_reset_clears_everything() {
        let mut runtime = MasterRuntime::with_scheduler(Box::new(RecordingScheduler::default()));
        assert!(runtime.repository_if_open().is_none());

        runtime.set_repository(SqliteMasterRepository::open(":memory:").unwrap());
        assert!(runtime.repository_if_open().is_some());

        runtime.tracker().set("u1::w1", "2026-03-04");
        assert_eq!(runtime.tracker().len(), 1);

        runtime.reset();
        assert!(runtime.repository_if_open().is_none());
        assert!(runtime.tracker().is_empty());
    }

    /// Forwards to the wrapped scheduler so the test can keep an `Arc` handle to
    /// the same instance the runtime owns.
    impl<T: MasterMaintenanceScheduler + ?Sized> MasterMaintenanceScheduler for Arc<T> {
        fn ensure(&self) {
            (**self).ensure();
        }
        fn stop(&self) {
            (**self).stop();
        }
    }

    #[test]
    fn an_injected_scheduler_sees_the_ensure_and_stop_calls() {
        let scheduler = Arc::new(RecordingScheduler::default());
        let mut runtime = MasterRuntime::with_scheduler(Box::new(Arc::clone(&scheduler)));
        assert!(scheduler.calls.lock().unwrap().is_empty());

        runtime.set_repository(SqliteMasterRepository::open(":memory:").unwrap());
        assert_eq!(scheduler.calls.lock().unwrap().as_slice(), &["ensure"]);

        runtime.reset();
        assert_eq!(
            scheduler.calls.lock().unwrap().as_slice(),
            &["ensure", "stop"]
        );
    }
}
