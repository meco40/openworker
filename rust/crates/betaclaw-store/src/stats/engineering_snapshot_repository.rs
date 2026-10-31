//! Port of `src/server/stats/engineeringSnapshotRepository.ts`.
//!
//! The six `engineering_*` and `harness_run_events` tables are created by the
//! migrations 009 to 012 (`engineering_migrations`, the port of
//! `src/lib/db/migrations.ts`) in the main database. This repository does not run
//! migrations; the caller runs `run_engineering_migrations` first. The tests do
//! the same on an in-memory database.

use std::sync::{Mutex, MutexGuard};

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;

use super::harness_rollout::GateStatus;
use super::util::{now_ms, short_uuid};
use super::StatsError;
use crate::db::OpenOptions;

string_enum!(RunStatus {
    Success = "success",
    Failure = "failure",
    Cancelled = "cancelled",
    Skipped = "skipped",
});

#[derive(Debug, Clone, PartialEq)]
pub struct StoredSnapshot {
    pub window_days: u32,
    /// Always a JSON object.
    pub payload: Value,
    pub source: String,
    pub generated_at: String,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct StoredBaseline {
    pub id: String,
    pub window_start: String,
    pub window_end: String,
    /// Always a JSON object.
    pub payload: Value,
    pub source: String,
    pub baseline_hash: String,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct StoredGateRun {
    pub id: String,
    pub phase_id: Option<String>,
    pub status: GateStatus,
    pub payload: Value,
    pub generated_at: String,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct BaselineInput {
    pub id: String,
    pub window_start: String,
    pub window_end: String,
    pub payload: Value,
    pub source: String,
    pub baseline_hash: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct GateRunInput {
    pub phase_id: Option<String>,
    pub status: GateStatus,
    pub payload: Value,
    pub generated_at: String,
}

/// `EngineeringPrFact`.
#[derive(Debug, Clone, PartialEq)]
pub struct PrFact {
    pub pr_number: i64,
    pub created_at: String,
    pub merged_at: String,
    pub additions: i64,
    pub deletions: i64,
    pub first_pass_blocking: bool,
    pub reverted: bool,
}

/// `HarnessRunEvent`. Empty optional strings are stored as `NULL`.
#[derive(Debug, Clone, PartialEq)]
pub struct HarnessRunEvent {
    pub trace_id: Option<String>,
    pub span_id: Option<String>,
    pub service_name: String,
    pub domain: Option<String>,
    pub lane: String,
    pub scenario: Option<String>,
    pub status: RunStatus,
    pub started_at: String,
    pub finished_at: String,
    pub duration_ms: i64,
    pub worktree_id: Option<String>,
    pub commit_sha: Option<String>,
    pub error_kind: Option<String>,
    pub run_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct LaneStat {
    pub lane: String,
    pub total_runs: i64,
    pub success_runs: i64,
    pub median_duration_ms: Option<i64>,
    pub flaky_suspicions: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DomainStat {
    pub domain: String,
    pub total_runs: i64,
    pub success_runs: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ScenarioStat {
    pub scenario: String,
    pub total_runs: i64,
    pub success_runs: i64,
    pub flaky_suspicions: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct WorktreeStat {
    pub worktree_id: String,
    pub total_runs: i64,
    pub success_runs: i64,
    pub last_finished_at: Option<String>,
}

/// `parseJsonObject`: `None` for invalid JSON and for anything but an object.
fn parse_payload(raw: &str) -> Option<Value> {
    serde_json::from_str::<Value>(raw)
        .ok()
        .filter(Value::is_object)
}

/// Empty optional strings are stored as `NULL`, as `value || null` does.
fn non_empty(value: &Option<String>) -> Option<&str> {
    value.as_deref().filter(|text| !text.is_empty())
}

pub struct EngineeringSnapshotRepository {
    connection: Mutex<Connection>,
}

impl EngineeringSnapshotRepository {
    /// Opens the database with the shared pragmas. The schema must already exist.
    pub fn open(db_path: &str) -> Result<Self, StatsError> {
        let connection = crate::db::open(OpenOptions::new(db_path))?;
        Ok(Self::from_connection(connection))
    }

    pub fn from_connection(connection: Connection) -> Self {
        Self {
            connection: Mutex::new(connection),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Connection> {
        self.connection
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    pub fn has_ingest_receipt(&self, idempotency_key: &str) -> Result<bool, StatsError> {
        let connection = self.lock();
        let found: Option<String> = connection
            .query_row(
                "SELECT idempotency_key FROM engineering_ingest_receipts WHERE idempotency_key = ?",
                [idempotency_key],
                |row| row.get(0),
            )
            .optional()?;
        Ok(found.is_some())
    }

    pub fn create_ingest_receipt(
        &self,
        idempotency_key: &str,
        received_at: &str,
    ) -> Result<(), StatsError> {
        let connection = self.lock();
        connection.execute(
            "INSERT INTO engineering_ingest_receipts (idempotency_key, received_at) VALUES (?, ?)",
            params![idempotency_key, received_at],
        )?;
        Ok(())
    }

    /// `storeEngineeringSnapshot`.
    pub fn store_snapshot(
        &self,
        window_days: u32,
        payload: &Value,
        source: &str,
        generated_at: &str,
    ) -> Result<(), StatsError> {
        let id = format!("es-{}-{}", now_ms(), short_uuid());
        let connection = self.lock();
        connection.execute(
            "INSERT INTO engineering_metrics_snapshots (id, window_days, payload_json, source, generated_at)
             VALUES (?, ?, ?, ?, ?)",
            params![id, window_days, payload.to_string(), source, generated_at],
        )?;
        Ok(())
    }

    /// `replaceEngineeringPrFacts`: replaces the whole table in one transaction.
    pub fn replace_pr_facts(&self, facts: &[PrFact]) -> Result<(), StatsError> {
        let mut connection = self.lock();
        let transaction = connection.transaction()?;
        transaction.execute("DELETE FROM engineering_pr_facts", [])?;
        for fact in facts {
            let id = format!("pr-{}-{}", fact.pr_number, fact.merged_at);
            transaction.execute(
                "INSERT INTO engineering_pr_facts (
                   id, pr_number, created_at, merged_at, additions, deletions, first_pass_blocking, reverted
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                params![
                    id,
                    fact.pr_number,
                    fact.created_at,
                    fact.merged_at,
                    fact.additions,
                    fact.deletions,
                    i64::from(fact.first_pass_blocking),
                    i64::from(fact.reverted),
                ],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    /// `appendHarnessRunEvents`, one transaction for the batch.
    pub fn append_harness_run_events(&self, events: &[HarnessRunEvent]) -> Result<(), StatsError> {
        let mut connection = self.lock();
        let transaction = connection.transaction()?;
        for event in events {
            let id = format!("he-{}-{}", now_ms(), short_uuid());
            transaction.execute(
                "INSERT INTO harness_run_events (
                   id, trace_id, span_id, service_name, domain, lane, scenario, status,
                   started_at, finished_at, duration_ms, worktree_id, commit_sha, error_kind, run_url
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                params![
                    id,
                    non_empty(&event.trace_id),
                    non_empty(&event.span_id),
                    event.service_name,
                    non_empty(&event.domain),
                    event.lane,
                    non_empty(&event.scenario),
                    event.status.as_str(),
                    event.started_at,
                    event.finished_at,
                    event.duration_ms.max(0),
                    non_empty(&event.worktree_id),
                    non_empty(&event.commit_sha),
                    non_empty(&event.error_kind),
                    non_empty(&event.run_url),
                ],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    /// `pruneHarnessRunEventsBefore`: returns the number of deleted rows.
    pub fn prune_harness_run_events_before(&self, cutoff_iso: &str) -> Result<usize, StatsError> {
        let connection = self.lock();
        Ok(connection.execute(
            "DELETE FROM harness_run_events WHERE finished_at < ?",
            [cutoff_iso],
        )?)
    }

    /// `getLatestEngineeringSnapshot`: the newest snapshot of the window, or
    /// `None` when there is none or its payload is not an object.
    pub fn latest_snapshot(&self, window_days: u32) -> Result<Option<StoredSnapshot>, StatsError> {
        let connection = self.lock();
        let row = connection
            .query_row(
                "SELECT window_days, payload_json, source, generated_at, created_at
                 FROM engineering_metrics_snapshots
                 WHERE window_days = ?
                 ORDER BY generated_at DESC
                 LIMIT 1",
                [window_days],
                |row| {
                    Ok((
                        row.get::<_, u32>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                    ))
                },
            )
            .optional()?;
        Ok(
            row.and_then(|(window_days, payload, source, generated_at, created_at)| {
                parse_payload(&payload).map(|payload| StoredSnapshot {
                    window_days,
                    payload,
                    source,
                    generated_at,
                    created_at,
                })
            }),
        )
    }

    /// `storeEngineeringRolloutBaseline`: `INSERT OR IGNORE`, so the first
    /// baseline with an id is kept.
    pub fn store_rollout_baseline(&self, input: &BaselineInput) -> Result<(), StatsError> {
        let connection = self.lock();
        connection.execute(
            "INSERT OR IGNORE INTO engineering_rollout_baselines (
               id, window_start, window_end, payload_json, source, baseline_hash
             ) VALUES (?, ?, ?, ?, ?, ?)",
            params![
                input.id,
                input.window_start,
                input.window_end,
                input.payload.to_string(),
                input.source,
                input.baseline_hash,
            ],
        )?;
        Ok(())
    }

    fn read_baseline(
        connection: &Connection,
        sql: &str,
        id: Option<&str>,
    ) -> Result<Option<StoredBaseline>, StatsError> {
        let row = match id {
            Some(id) => connection
                .query_row(sql, [id], map_baseline_row)
                .optional()?,
            None => connection.query_row(sql, [], map_baseline_row).optional()?,
        };
        Ok(row.and_then(|(record, payload)| {
            parse_payload(&payload).map(|payload| StoredBaseline { payload, ..record })
        }))
    }

    /// `getEngineeringRolloutBaselineById`.
    pub fn rollout_baseline_by_id(&self, id: &str) -> Result<Option<StoredBaseline>, StatsError> {
        let connection = self.lock();
        Self::read_baseline(
            &connection,
            "SELECT id, window_start, window_end, payload_json, source, baseline_hash, created_at
             FROM engineering_rollout_baselines
             WHERE id = ?
             LIMIT 1",
            Some(id),
        )
    }

    /// `getLatestEngineeringRolloutBaseline`.
    pub fn latest_rollout_baseline(&self) -> Result<Option<StoredBaseline>, StatsError> {
        let connection = self.lock();
        Self::read_baseline(
            &connection,
            "SELECT id, window_start, window_end, payload_json, source, baseline_hash, created_at
             FROM engineering_rollout_baselines
             ORDER BY created_at DESC
             LIMIT 1",
            None,
        )
    }

    /// `storeEngineeringRolloutGateRun`.
    pub fn store_rollout_gate_run(&self, input: &GateRunInput) -> Result<(), StatsError> {
        let id = format!("gr-{}-{}", now_ms(), short_uuid());
        let connection = self.lock();
        connection.execute(
            "INSERT INTO engineering_rollout_gate_runs (id, phase_id, status, payload_json, generated_at)
             VALUES (?, ?, ?, ?, ?)",
            params![
                id,
                input.phase_id,
                input.status.as_str(),
                input.payload.to_string(),
                input.generated_at,
            ],
        )?;
        Ok(())
    }

    /// `getLatestEngineeringRolloutGateRun`.
    pub fn latest_rollout_gate_run(&self) -> Result<Option<StoredGateRun>, StatsError> {
        let connection = self.lock();
        let row = connection
            .query_row(
                "SELECT id, phase_id, status, payload_json, generated_at, created_at
                 FROM engineering_rollout_gate_runs
                 ORDER BY generated_at DESC
                 LIMIT 1",
                [],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                    ))
                },
            )
            .optional()?;
        Ok(row.and_then(
            |(id, phase_id, status, payload, generated_at, created_at)| {
                parse_payload(&payload).map(|payload| StoredGateRun {
                    id,
                    phase_id,
                    // The table's CHECK constraint admits only the three values.
                    status: GateStatus::parse(&status).unwrap_or(GateStatus::Unknown),
                    payload,
                    generated_at,
                    created_at,
                })
            },
        ))
    }

    /// `getHarnessLaneStats`: runs, successes, average duration and flaky
    /// suspicions (failures and cancellations) per lane since `from_iso`.
    pub fn harness_lane_stats(&self, from_iso: &str) -> Result<Vec<LaneStat>, StatsError> {
        let connection = self.lock();
        let mut statement = connection.prepare(
            "SELECT
               lane,
               COUNT(*) AS total_runs,
               SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success_runs,
               CAST(AVG(duration_ms) AS INTEGER) AS median_duration_ms,
               SUM(CASE WHEN status = 'failure' OR status = 'cancelled' THEN 1 ELSE 0 END) AS flaky_suspicions
             FROM harness_run_events
             WHERE finished_at >= ?
             GROUP BY lane",
        )?;
        let rows = statement.query_map([from_iso], |row| {
            Ok(LaneStat {
                lane: row.get(0)?,
                total_runs: row.get(1)?,
                success_runs: row.get(2)?,
                median_duration_ms: row.get(3)?,
                flaky_suspicions: row.get(4)?,
            })
        })?;
        let stats: Vec<LaneStat> = rows.collect::<Result<_, _>>()?;
        Ok(stats)
    }

    /// `getHarnessDomainStats`: rows without a domain are left out.
    pub fn harness_domain_stats(&self, from_iso: &str) -> Result<Vec<DomainStat>, StatsError> {
        let connection = self.lock();
        let mut statement = connection.prepare(
            "SELECT
               domain,
               COUNT(*) AS total_runs,
               SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success_runs
             FROM harness_run_events
             WHERE finished_at >= ? AND domain IS NOT NULL AND TRIM(domain) != ''
             GROUP BY domain",
        )?;
        let rows = statement.query_map([from_iso], |row| {
            Ok(DomainStat {
                domain: row.get::<_, String>(0)?.trim().to_string(),
                total_runs: row.get(1)?,
                success_runs: row.get(2)?,
            })
        })?;
        let stats: Vec<DomainStat> = rows.collect::<Result<_, _>>()?;
        Ok(stats)
    }

    /// `getHarnessScenarioStats`: rows without a scenario are left out.
    pub fn harness_scenario_stats(&self, from_iso: &str) -> Result<Vec<ScenarioStat>, StatsError> {
        let connection = self.lock();
        let mut statement = connection.prepare(
            "SELECT
               scenario,
               COUNT(*) AS total_runs,
               SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success_runs,
               SUM(CASE WHEN status = 'failure' OR status = 'cancelled' THEN 1 ELSE 0 END) AS flaky_suspicions
             FROM harness_run_events
             WHERE finished_at >= ? AND scenario IS NOT NULL AND TRIM(scenario) != ''
             GROUP BY scenario",
        )?;
        let rows = statement.query_map([from_iso], |row| {
            Ok(ScenarioStat {
                scenario: row.get::<_, String>(0)?.trim().to_string(),
                total_runs: row.get(1)?,
                success_runs: row.get(2)?,
                flaky_suspicions: row.get(3)?,
            })
        })?;
        let stats: Vec<ScenarioStat> = rows.collect::<Result<_, _>>()?;
        Ok(stats)
    }

    /// `getHarnessWorktreeStats`: rows without a worktree are left out.
    pub fn harness_worktree_stats(&self, from_iso: &str) -> Result<Vec<WorktreeStat>, StatsError> {
        let connection = self.lock();
        let mut statement = connection.prepare(
            "SELECT
               worktree_id,
               COUNT(*) AS total_runs,
               SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success_runs,
               MAX(finished_at) AS last_finished_at
             FROM harness_run_events
             WHERE finished_at >= ? AND worktree_id IS NOT NULL AND TRIM(worktree_id) != ''
             GROUP BY worktree_id",
        )?;
        let rows = statement.query_map([from_iso], |row| {
            Ok(WorktreeStat {
                worktree_id: row.get::<_, String>(0)?.trim().to_string(),
                total_runs: row.get(1)?,
                success_runs: row.get(2)?,
                last_finished_at: row.get(3)?,
            })
        })?;
        let stats: Vec<WorktreeStat> = rows.collect::<Result<_, _>>()?;
        Ok(stats)
    }

    /// `getGuardianAutoRevertCount`: successful `guardian-auto-revert` runs.
    pub fn guardian_auto_revert_count(&self, from_iso: &str) -> Result<i64, StatsError> {
        let connection = self.lock();
        let count = connection.query_row(
            "SELECT COUNT(*) FROM harness_run_events
             WHERE finished_at >= ?
               AND lane = 'main-guardian'
               AND scenario = 'guardian-auto-revert'
               AND status = 'success'",
            [from_iso],
            |row| row.get(0),
        )?;
        Ok(count)
    }
}

type BaselineRow = (StoredBaseline, String);

/// The baseline columns, with the payload kept as text for the JSON check.
fn map_baseline_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<BaselineRow> {
    let record = StoredBaseline {
        id: row.get(0)?,
        window_start: row.get(1)?,
        window_end: row.get(2)?,
        payload: Value::Null,
        source: row.get(4)?,
        baseline_hash: row.get(5)?,
        created_at: row.get(6)?,
    };
    Ok((record, row.get(3)?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    use crate::stats::engineering_migrations::run_engineering_migrations;

    fn repository() -> EngineeringSnapshotRepository {
        let mut connection = crate::db::open(OpenOptions::new(":memory:")).expect("open");
        run_engineering_migrations(&mut connection).expect("migrate");
        EngineeringSnapshotRepository::from_connection(connection)
    }

    fn event(lane: &str, status: RunStatus, duration: i64) -> HarnessRunEvent {
        HarnessRunEvent {
            trace_id: None,
            span_id: None,
            service_name: "ci".into(),
            domain: Some(" core-api ".into()),
            lane: lane.into(),
            scenario: Some("".into()),
            status,
            started_at: "2026-06-10T10:00:00.000Z".into(),
            finished_at: "2026-06-10T10:05:00.000Z".into(),
            duration_ms: duration,
            worktree_id: Some("wt-1".into()),
            commit_sha: None,
            error_kind: None,
            run_url: None,
        }
    }

    #[test]
    fn ingest_receipts_are_recorded_once_looked_up() {
        let repository = repository();
        assert!(!repository.has_ingest_receipt("k1").expect("lookup"));
        repository
            .create_ingest_receipt("k1", "2026-06-10T10:00:00.000Z")
            .expect("create");
        assert!(repository.has_ingest_receipt("k1").expect("lookup"));
    }

    #[test]
    fn latest_snapshot_is_per_window_and_newest_first() {
        let repository = repository();
        repository
            .store_snapshot(
                7,
                &json!({ "flakyRate": 0.1 }),
                "snapshot",
                "2026-06-01T00:00:00.000Z",
            )
            .expect("store");
        repository
            .store_snapshot(
                7,
                &json!({ "flakyRate": 0.2 }),
                "snapshot",
                "2026-06-02T00:00:00.000Z",
            )
            .expect("store");

        let latest = repository
            .latest_snapshot(7)
            .expect("latest")
            .expect("present");
        assert_eq!(latest.payload["flakyRate"], 0.2);
        assert_eq!(latest.generated_at, "2026-06-02T00:00:00.000Z");
        assert!(repository.latest_snapshot(30).expect("latest").is_none());
    }

    #[test]
    fn a_snapshot_payload_that_is_not_an_object_is_ignored() {
        let repository = repository();
        {
            let connection = repository.lock();
            connection
                .execute(
                    "INSERT INTO engineering_metrics_snapshots (id, window_days, payload_json, source, generated_at)
                     VALUES ('x', 30, '[1,2]', 'snapshot', '2026-06-01T00:00:00.000Z')",
                    [],
                )
                .expect("insert");
        }
        assert!(repository.latest_snapshot(30).expect("latest").is_none());
    }

    #[test]
    fn baseline_insert_is_ignored_when_the_id_exists() {
        let repository = repository();
        let first = BaselineInput {
            id: "baseline-1".into(),
            window_start: "2026-02-07T00:00:00Z".into(),
            window_end: "2026-03-08T23:59:59Z".into(),
            payload: json!({ "firstPassCiRate": 0.5 }),
            source: "github-snapshot".into(),
            baseline_hash: "h1".into(),
        };
        repository.store_rollout_baseline(&first).expect("store");
        let second = BaselineInput {
            payload: json!({ "firstPassCiRate": 0.9 }),
            baseline_hash: "h2".into(),
            ..first.clone()
        };
        repository
            .store_rollout_baseline(&second)
            .expect("store again");

        let stored = repository
            .rollout_baseline_by_id("baseline-1")
            .expect("by id")
            .expect("present");
        assert_eq!(stored.payload["firstPassCiRate"], 0.5);
        assert_eq!(stored.baseline_hash, "h1");
        assert!(repository
            .latest_rollout_baseline()
            .expect("latest")
            .is_some());
    }

    #[test]
    fn gate_runs_round_trip_their_status() {
        let repository = repository();
        repository
            .store_rollout_gate_run(&GateRunInput {
                phase_id: Some("week-1".into()),
                status: GateStatus::Fail,
                payload: json!({ "overall": "fail" }),
                generated_at: "2026-06-10T00:00:00.000Z".into(),
            })
            .expect("store");
        let run = repository
            .latest_rollout_gate_run()
            .expect("latest")
            .expect("present");
        assert_eq!(run.status, GateStatus::Fail);
        assert_eq!(run.phase_id.as_deref(), Some("week-1"));
    }

    #[test]
    fn events_append_prune_and_feed_the_stats() {
        let repository = repository();
        repository
            .append_harness_run_events(&[
                event("unit", RunStatus::Success, 100),
                event("unit", RunStatus::Failure, 300),
                event("e2e", RunStatus::Cancelled, 50),
            ])
            .expect("append");

        let lanes = repository
            .harness_lane_stats("2026-06-01T00:00:00.000Z")
            .expect("lanes");
        let unit = lanes.iter().find(|lane| lane.lane == "unit").expect("unit");
        assert_eq!(unit.total_runs, 2);
        assert_eq!(unit.success_runs, 1);
        assert_eq!(unit.median_duration_ms, Some(200));
        assert_eq!(unit.flaky_suspicions, 1);

        let domains = repository
            .harness_domain_stats("2026-06-01T00:00:00.000Z")
            .expect("domains");
        assert_eq!(domains[0].domain, "core-api", "domain is trimmed");
        assert!(repository
            .harness_scenario_stats("2026-06-01T00:00:00.000Z")
            .expect("scenarios")
            .is_empty());
        let worktrees = repository
            .harness_worktree_stats("2026-06-01T00:00:00.000Z")
            .expect("worktrees");
        assert_eq!(worktrees[0].total_runs, 3);

        let pruned = repository
            .prune_harness_run_events_before("2026-07-01T00:00:00.000Z")
            .expect("prune");
        assert_eq!(pruned, 3);
    }

    #[test]
    fn pr_facts_are_replaced_as_a_whole() {
        let repository = repository();
        let fact = |number: i64| PrFact {
            pr_number: number,
            created_at: "2026-06-01T00:00:00Z".into(),
            merged_at: "2026-06-02T00:00:00Z".into(),
            additions: 10,
            deletions: 2,
            first_pass_blocking: true,
            reverted: false,
        };
        repository
            .replace_pr_facts(&[fact(1), fact(2)])
            .expect("first");
        repository.replace_pr_facts(&[fact(3)]).expect("second");
        let connection = repository.lock();
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM engineering_pr_facts", [], |row| {
                row.get(0)
            })
            .expect("count");
        assert_eq!(count, 1);
    }

    #[test]
    fn guardian_reverts_count_only_successful_runs() {
        let repository = repository();
        let mut revert = event("main-guardian", RunStatus::Success, 10);
        revert.scenario = Some("guardian-auto-revert".into());
        let mut failed = revert.clone();
        failed.status = RunStatus::Failure;
        repository
            .append_harness_run_events(&[revert, failed])
            .expect("append");
        assert_eq!(
            repository
                .guardian_auto_revert_count("2026-06-01T00:00:00.000Z")
                .expect("count"),
            1
        );
    }
}
