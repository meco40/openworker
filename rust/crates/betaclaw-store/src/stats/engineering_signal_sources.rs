//! Port of the signal reads of `src/server/stats/engineeringMetricsService.ts`:
//! `resolveScopes`, `collectRunSignals` (master), and `collectMergeSizedChanges`
//! and `collectAsyncFailures` (tasks).
//!
//! The master repository belongs to S9 and the task tables to S10. Their reads
//! sit behind [`MasterSignalSource`] and [`TaskSignalSource`], and the slices that
//! own them implement the traits. [`SqliteTaskSignals`] is the SQL that the
//! TypeScript runs over `tasks` and `task_activities` in the main database.
//! [`collect_engineering_metrics_snapshot_from_sources`] is
//! `collectEngineeringMetricsSnapshot` with these reads plugged in.

use chrono::{DateTime, Utc};
use rusqlite::Connection;

use super::engineering_metrics::{
    CompletedRunSignal, EngineeringMetricsSnapshot, EngineeringSignalSet,
};
use super::engineering_metrics_service::{
    async_failure_breached, collect_engineering_metrics_snapshot, extract_merge_size,
    window_start_iso, CollectData,
};
use super::util::parse_iso_ms;
use super::StatsError;

/// `DEFAULT_WORKSPACE_ID`.
const DEFAULT_WORKSPACE_ID: &str = "default";
/// `listKnownScopes(500)`.
const KNOWN_SCOPES_LIMIT: usize = 500;
/// `listRuns(scope, 500)`.
const RUNS_LIMIT: usize = 500;
/// `listAuditEvents(scope, 1000)`.
const AUDIT_EVENTS_LIMIT: usize = 1000;

/// `WorkspaceScope` of the master repository.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceScope {
    pub user_id: String,
    pub workspace_id: String,
}

/// The fields of a master run that the metrics read. `status` is the
/// TypeScript status string, such as `COMPLETED`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MasterRunRecord {
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
    pub verification_passed: bool,
}

/// The master reads of the metrics. Implemented by the master slice (S9).
pub trait MasterSignalSource {
    /// `listKnownScopes(limit)`.
    fn known_scopes(&self, limit: usize) -> Result<Vec<WorkspaceScope>, StatsError>;
    /// `listRuns(scope, limit)`.
    fn runs(
        &self,
        scope: &WorkspaceScope,
        limit: usize,
    ) -> Result<Vec<MasterRunRecord>, StatsError>;
    /// The `action` of each `listAuditEvents(scope, limit)` row.
    fn audit_actions(
        &self,
        scope: &WorkspaceScope,
        limit: usize,
    ) -> Result<Vec<String>, StatsError>;
}

/// One task with a `test_failed` activity, as `collectAsyncFailures` groups them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AsyncFailureRow {
    pub status: Option<String>,
    pub updated_at: Option<String>,
    pub failed_at: Option<String>,
}

/// The task reads of the metrics. Implemented by the tasks slice (S10), or by
/// [`SqliteTaskSignals`].
pub trait TaskSignalSource {
    /// `metadata` of the `completed`, `status_changed` and `test_passed`
    /// activities since `from_iso`.
    fn merge_metadata(&self, from_iso: &str) -> Result<Vec<Option<String>>, StatsError>;
    /// The tasks with a `test_failed` activity since `from_iso`, one row per task.
    fn async_failure_rows(&self, from_iso: &str) -> Result<Vec<AsyncFailureRow>, StatsError>;
}

/// [`TaskSignalSource`] over the main database's `tasks` and `task_activities`.
pub struct SqliteTaskSignals<'a> {
    connection: &'a Connection,
}

impl<'a> SqliteTaskSignals<'a> {
    pub fn new(connection: &'a Connection) -> Self {
        Self { connection }
    }
}

impl TaskSignalSource for SqliteTaskSignals<'_> {
    fn merge_metadata(&self, from_iso: &str) -> Result<Vec<Option<String>>, StatsError> {
        let mut statement = self.connection.prepare(
            "SELECT metadata
             FROM task_activities
             WHERE activity_type IN ('completed', 'status_changed', 'test_passed')
               AND created_at >= ?",
        )?;
        let rows = statement.query_map([from_iso], |row| row.get::<_, Option<String>>(0))?;
        let metadata: Vec<Option<String>> = rows.collect::<Result<_, _>>()?;
        Ok(metadata)
    }

    fn async_failure_rows(&self, from_iso: &str) -> Result<Vec<AsyncFailureRow>, StatsError> {
        let mut statement = self.connection.prepare(
            "SELECT t.status, t.updated_at, MAX(a.created_at) AS failed_at
             FROM tasks t
             JOIN task_activities a ON a.task_id = t.id
             WHERE a.activity_type = 'test_failed'
               AND a.created_at >= ?
             GROUP BY t.id, t.status, t.updated_at",
        )?;
        let rows = statement.query_map([from_iso], |row| {
            Ok(AsyncFailureRow {
                status: row.get(0)?,
                updated_at: row.get(1)?,
                failed_at: row.get(2)?,
            })
        })?;
        let failures: Vec<AsyncFailureRow> = rows.collect::<Result<_, _>>()?;
        Ok(failures)
    }
}

/// `resolveScopes`: the given workspace, else the user's known scopes, else the
/// default workspace of the user. The master is read only when no workspace is given.
pub fn resolve_scopes(
    master: &dyn MasterSignalSource,
    user_id: &str,
    workspace_id: Option<&str>,
) -> Result<Vec<WorkspaceScope>, StatsError> {
    if let Some(workspace_id) = workspace_id.filter(|id| !id.is_empty()) {
        return Ok(vec![WorkspaceScope {
            user_id: user_id.to_string(),
            workspace_id: workspace_id.to_string(),
        }]);
    }
    let known: Vec<WorkspaceScope> = master
        .known_scopes(KNOWN_SCOPES_LIMIT)?
        .into_iter()
        .filter(|scope| scope.user_id == user_id)
        .collect();
    if !known.is_empty() {
        return Ok(known);
    }
    Ok(vec![WorkspaceScope {
        user_id: user_id.to_string(),
        workspace_id: DEFAULT_WORKSPACE_ID.to_string(),
    }])
}

/// The signal set of `collectEngineeringMetricsSnapshot`'s fallback path for the
/// window that ends at `now`: `collectRunSignals`, `collectMergeSizedChanges`
/// and `collectAsyncFailures`, in that order.
pub fn collect_signal_set(
    master: &dyn MasterSignalSource,
    tasks: &dyn TaskSignalSource,
    user_id: &str,
    workspace_id: Option<&str>,
    window_days: u32,
    now: DateTime<Utc>,
) -> Result<EngineeringSignalSet, StatsError> {
    let from_iso = window_start_iso(now, window_days);
    let from_ms = parse_iso_ms(&from_iso).unwrap_or(0);

    let mut signals = empty_signal_set(window_days);
    for scope in resolve_scopes(master, user_id, workspace_id)? {
        for run in master.runs(&scope, RUNS_LIMIT)? {
            let in_window = matches!(parse_iso_ms(&run.updated_at), Some(ms) if ms >= from_ms);
            if run.status != "COMPLETED" || !in_window {
                continue;
            }
            signals.completed_runs.push(CompletedRunSignal {
                created_at: run.created_at,
                completed_at: run.updated_at,
                requires_refinement: !run.verification_passed,
            });
            signals.verification_passed.push(run.verification_passed);
        }
        signals.rollback_events += master
            .audit_actions(&scope, AUDIT_EVENTS_LIMIT)?
            .iter()
            .filter(|action| action.contains("rollback"))
            .count() as i64;
    }

    signals.merge_sized_changes = tasks
        .merge_metadata(&from_iso)?
        .iter()
        .filter_map(|metadata| extract_merge_size(metadata.as_deref()))
        .collect();

    let now_ms = now.timestamp_millis();
    signals.async_failure_breaches = tasks
        .async_failure_rows(&from_iso)?
        .iter()
        .map(|row| {
            async_failure_breached(
                row.status.as_deref(),
                row.updated_at.as_deref(),
                row.failed_at.as_deref(),
                now_ms,
            )
        })
        .collect();

    Ok(signals)
}

/// `collectEngineeringMetricsSnapshot` with the reads of this module. The
/// sources are read only on the fallback path, as in the TypeScript. A failed
/// read is returned as the error, not turned into a fallback.
pub fn collect_engineering_metrics_snapshot_from_sources(
    window_days: u32,
    now: DateTime<Utc>,
    data: &CollectData,
    user_id: &str,
    workspace_id: Option<&str>,
    master: &dyn MasterSignalSource,
    tasks: &dyn TaskSignalSource,
) -> Result<EngineeringMetricsSnapshot, StatsError> {
    let mut failure = None;
    let snapshot = collect_engineering_metrics_snapshot(window_days, now, data, || {
        collect_signal_set(master, tasks, user_id, workspace_id, window_days, now).unwrap_or_else(
            |error| {
                failure = Some(error);
                empty_signal_set(window_days)
            },
        )
    });
    match failure {
        Some(error) => Err(error),
        None => Ok(snapshot),
    }
}

fn empty_signal_set(window_days: u32) -> EngineeringSignalSet {
    EngineeringSignalSet {
        window_days,
        completed_runs: Vec::new(),
        verification_passed: Vec::new(),
        rollback_events: 0,
        merge_sized_changes: Vec::new(),
        async_failure_breaches: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stats::engineering_metrics::SnapshotSource;
    use crate::stats::engineering_metrics_service::RolloutState;
    use crate::stats::engineering_snapshot_repository::StoredSnapshot;
    use crate::stats::harness_rollout::HarnessRolloutConfig;
    use serde_json::json;

    #[derive(Default)]
    struct FakeMaster {
        scopes: Vec<WorkspaceScope>,
        runs: Vec<MasterRunRecord>,
        actions: Vec<String>,
        fail: bool,
    }

    impl FakeMaster {
        fn check(&self) -> Result<(), StatsError> {
            if self.fail {
                return Err(StatsError::Io(std::io::Error::other("master unavailable")));
            }
            Ok(())
        }
    }

    impl MasterSignalSource for FakeMaster {
        fn known_scopes(&self, _limit: usize) -> Result<Vec<WorkspaceScope>, StatsError> {
            self.check()?;
            Ok(self.scopes.clone())
        }

        fn runs(
            &self,
            _scope: &WorkspaceScope,
            _limit: usize,
        ) -> Result<Vec<MasterRunRecord>, StatsError> {
            self.check()?;
            Ok(self.runs.clone())
        }

        fn audit_actions(
            &self,
            _scope: &WorkspaceScope,
            _limit: usize,
        ) -> Result<Vec<String>, StatsError> {
            self.check()?;
            Ok(self.actions.clone())
        }
    }

    #[derive(Default)]
    struct FakeTasks {
        merge: Vec<Option<String>>,
        failures: Vec<AsyncFailureRow>,
    }

    impl TaskSignalSource for FakeTasks {
        fn merge_metadata(&self, _from_iso: &str) -> Result<Vec<Option<String>>, StatsError> {
            Ok(self.merge.clone())
        }

        fn async_failure_rows(&self, _from_iso: &str) -> Result<Vec<AsyncFailureRow>, StatsError> {
            Ok(self.failures.clone())
        }
    }

    fn now() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-06-10T12:00:00Z")
            .expect("valid")
            .with_timezone(&Utc)
    }

    fn scope(user_id: &str, workspace_id: &str) -> WorkspaceScope {
        WorkspaceScope {
            user_id: user_id.into(),
            workspace_id: workspace_id.into(),
        }
    }

    fn run(status: &str, updated_at: &str, verified: bool) -> MasterRunRecord {
        MasterRunRecord {
            status: status.into(),
            created_at: "2026-06-01T00:00:00.000Z".into(),
            updated_at: updated_at.into(),
            verification_passed: verified,
        }
    }

    fn collect_data(latest: Option<StoredSnapshot>) -> CollectData {
        CollectData {
            active_domains: Vec::new(),
            lane_stats: Vec::new(),
            domain_stats: Vec::new(),
            scenario_stats: Vec::new(),
            worktree_stats: Vec::new(),
            guardian_auto_reverts: 0,
            latest,
            rollout: RolloutState {
                config: HarnessRolloutConfig::unavailable(),
                baseline: None,
            },
        }
    }

    /// The columns the task reads use, from `src/lib/db/schema.ts`.
    fn task_database() -> Connection {
        let connection = Connection::open_in_memory().expect("open");
        connection
            .execute_batch(
                "CREATE TABLE tasks (id TEXT PRIMARY KEY, status TEXT, updated_at TEXT);
                 CREATE TABLE task_activities (
                   id TEXT PRIMARY KEY, task_id TEXT NOT NULL, activity_type TEXT NOT NULL,
                   metadata TEXT, created_at TEXT
                 );
                 INSERT INTO tasks (id, status, updated_at) VALUES
                   ('t1', 'in_progress', '2026-06-01T00:00:00.000Z'),
                   ('t2', 'done', '2026-06-01T00:00:00.000Z');
                 INSERT INTO task_activities (id, task_id, activity_type, metadata, created_at) VALUES
                   ('a1', 't1', 'test_failed', NULL, '2026-06-02T00:00:00.000Z'),
                   ('a2', 't1', 'test_failed', NULL, '2026-06-04T00:00:00.000Z'),
                   ('a3', 't2', 'test_failed', NULL, '2026-06-04T00:00:00.000Z'),
                   ('a4', 't1', 'completed', '{\"changedLines\": 40}', '2026-06-05T00:00:00.000Z'),
                   ('a5', 't1', 'status_changed', NULL, '2026-06-05T00:00:00.000Z'),
                   ('a6', 't1', 'message', '{\"changedLines\": 9}', '2026-06-05T00:00:00.000Z'),
                   ('a7', 't1', 'completed', '{\"changedLines\": 10}', '2026-05-01T00:00:00.000Z');",
            )
            .expect("fixture");
        connection
    }

    #[test]
    fn scopes_come_from_the_workspace_then_the_users_known_scopes() {
        let master = FakeMaster {
            scopes: vec![scope("u1", "a"), scope("u2", "b")],
            ..Default::default()
        };
        assert_eq!(
            resolve_scopes(&master, "u1", None).expect("known"),
            vec![scope("u1", "a")]
        );
        assert_eq!(
            resolve_scopes(&master, "u3", None).expect("default"),
            vec![scope("u3", "default")]
        );

        let down = FakeMaster {
            fail: true,
            ..Default::default()
        };
        assert_eq!(
            resolve_scopes(&down, "u1", Some("x")).expect("no master read"),
            vec![scope("u1", "x")]
        );
        assert!(resolve_scopes(&down, "u1", None).is_err());
    }

    #[test]
    fn run_signals_keep_completed_runs_in_the_window_and_count_rollbacks() {
        let master = FakeMaster {
            runs: vec![
                run("COMPLETED", "2026-06-09T10:00:00.000Z", true),
                run("COMPLETED", "2026-05-01T10:00:00.000Z", true),
                run("FAILED", "2026-06-09T10:00:00.000Z", false),
                run("COMPLETED", "2026-06-08T10:00:00.000Z", false),
            ],
            actions: vec![
                "run.rollback".into(),
                "task.created".into(),
                "rollback_done".into(),
            ],
            ..Default::default()
        };
        let signals = collect_signal_set(&master, &FakeTasks::default(), "u1", Some("a"), 7, now())
            .expect("signals");

        assert_eq!(signals.window_days, 7);
        assert_eq!(signals.completed_runs.len(), 2);
        assert_eq!(signals.verification_passed, vec![true, false]);
        assert!(!signals.completed_runs[0].requires_refinement);
        assert!(signals.completed_runs[1].requires_refinement);
        assert_eq!(signals.rollback_events, 2);
    }

    #[test]
    fn merge_sizes_and_async_breaches_follow_the_rules() {
        let tasks = FakeTasks {
            merge: vec![
                Some(r#"{"changedLines": 120}"#.into()),
                None,
                Some(r#"{"diffLines": 0}"#.into()),
            ],
            failures: vec![
                AsyncFailureRow {
                    status: Some("in_progress".into()),
                    updated_at: Some("2026-06-01T00:00:00.000Z".into()),
                    failed_at: None,
                },
                AsyncFailureRow {
                    status: Some("done".into()),
                    updated_at: Some("2026-06-01T00:00:00.000Z".into()),
                    failed_at: None,
                },
            ],
        };
        let signals = collect_signal_set(&FakeMaster::default(), &tasks, "u1", Some("a"), 7, now())
            .expect("signals");

        assert_eq!(signals.merge_sized_changes, vec![120]);
        assert_eq!(signals.async_failure_breaches, vec![true, false]);
    }

    #[test]
    fn sqlite_task_reads_apply_the_activity_and_window_filters() {
        let connection = task_database();
        let tasks = SqliteTaskSignals::new(&connection);
        let from = "2026-06-03T12:00:00.000Z";

        let metadata = tasks.merge_metadata(from).expect("merge");
        assert_eq!(
            metadata.len(),
            2,
            "completed and status_changed in the window"
        );
        let sizes: Vec<i64> = metadata
            .iter()
            .filter_map(|value| extract_merge_size(value.as_deref()))
            .collect();
        assert_eq!(sizes, vec![40]);

        let rows = tasks.async_failure_rows(from).expect("failures");
        assert_eq!(rows.len(), 2);
        let open = rows
            .iter()
            .find(|row| row.status.as_deref() == Some("in_progress"))
            .expect("t1");
        assert_eq!(
            open.failed_at.as_deref(),
            Some("2026-06-04T00:00:00.000Z"),
            "the latest failure of the task"
        );

        let signals = collect_signal_set(&FakeMaster::default(), &tasks, "u1", Some("a"), 7, now())
            .expect("signals");
        assert_eq!(signals.merge_sized_changes, vec![40]);
        assert_eq!(
            signals
                .async_failure_breaches
                .iter()
                .filter(|breached| **breached)
                .count(),
            1
        );
    }

    #[test]
    fn the_sources_are_read_only_when_no_fresh_snapshot_exists() {
        let down = FakeMaster {
            fail: true,
            ..Default::default()
        };
        let fresh = StoredSnapshot {
            window_days: 7,
            payload: json!({ "flakyRate": 0.01 }),
            source: "snapshot".into(),
            generated_at: "2026-06-10T11:00:00.000Z".into(),
            created_at: "2026-06-10T11:00:00.000Z".into(),
        };
        let served = collect_engineering_metrics_snapshot_from_sources(
            7,
            now(),
            &collect_data(Some(fresh)),
            "u1",
            None,
            &down,
            &FakeTasks::default(),
        )
        .expect("served from the stored snapshot");
        assert_eq!(served.source, Some(SnapshotSource::Snapshot));

        let failed = collect_engineering_metrics_snapshot_from_sources(
            7,
            now(),
            &collect_data(None),
            "u1",
            None,
            &down,
            &FakeTasks::default(),
        );
        assert!(failed.is_err(), "a failed read is not hidden as a fallback");
    }
}
