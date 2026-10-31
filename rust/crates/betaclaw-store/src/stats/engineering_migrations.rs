//! Port of the migrations 009 to 012 in `src/lib/db/migrations.ts`: the
//! engineering metrics snapshots, PR facts and ingest receipts (009), the
//! harness run events (010), their v3 columns (011), and the rollout baselines
//! and gate runs (012).
//!
//! The statements are the TypeScript ones, in the same order. The `_migrations`
//! ledger has the TypeScript columns, and each migration writes its ledger row in
//! the same transaction as its DDL, so a database migrated by either side reads as
//! migrated by the other.
//!
//! Scope: only 009 to 012 run here. Migrations 001 to 008 and 013 to 014 belong to
//! the other slices; a runner for the whole list has to call this function at the
//! right position.

use std::collections::HashSet;

use rusqlite::{params, Connection};

/// `runMigrations`: the ledger table, created before anything else.
const LEDGER_DDL: &str = "
    CREATE TABLE IF NOT EXISTS _migrations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT DEFAULT (datetime('now'))
    )";

/// The v3 columns that migration 011 adds to a table created before them.
const V3_COLUMNS: [&str; 4] = ["domain", "scenario", "worktree_id", "commit_sha"];

struct Migration {
    id: &'static str,
    name: &'static str,
    up: fn(&Connection) -> rusqlite::Result<()>,
}

const MIGRATIONS: [Migration; 4] = [
    Migration {
        id: "009",
        name: "add_engineering_metrics_tables",
        up: up_009,
    },
    Migration {
        id: "010",
        name: "add_harness_run_events_table",
        up: up_010,
    },
    Migration {
        id: "011",
        name: "extend_harness_run_events_v3",
        up: up_011,
    },
    Migration {
        id: "012",
        name: "add_engineering_rollout_tables",
        up: up_012,
    },
];

/// `runMigrations` for migrations 009 to 012. Applies the pending ones in order
/// and returns their ids. A migration that fails rolls back with its ledger row.
pub fn run_engineering_migrations(
    connection: &mut Connection,
) -> rusqlite::Result<Vec<&'static str>> {
    connection.execute_batch(LEDGER_DDL)?;
    let applied: HashSet<String> = {
        let mut statement = connection.prepare("SELECT id FROM _migrations")?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        rows.collect::<rusqlite::Result<_>>()?
    };

    let mut newly_applied = Vec::new();
    for migration in &MIGRATIONS {
        if applied.contains(migration.id) {
            continue;
        }
        let transaction = connection.transaction()?;
        (migration.up)(&transaction)?;
        transaction.execute(
            "INSERT INTO _migrations (id, name) VALUES (?, ?)",
            params![migration.id, migration.name],
        )?;
        transaction.commit()?;
        newly_applied.push(migration.id);
    }
    Ok(newly_applied)
}

fn up_009(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS engineering_metrics_snapshots (
          id TEXT PRIMARY KEY,
          window_days INTEGER NOT NULL CHECK (window_days IN (7, 30)),
          payload_json TEXT NOT NULL,
          source TEXT NOT NULL,
          generated_at TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_engineering_metrics_snapshots_window_generated
        ON engineering_metrics_snapshots (window_days, generated_at DESC);
        CREATE TABLE IF NOT EXISTS engineering_pr_facts (
          id TEXT PRIMARY KEY,
          pr_number INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          merged_at TEXT NOT NULL,
          additions INTEGER NOT NULL DEFAULT 0,
          deletions INTEGER NOT NULL DEFAULT 0,
          first_pass_blocking INTEGER NOT NULL DEFAULT 0,
          reverted INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_engineering_pr_facts_merged
        ON engineering_pr_facts (merged_at DESC);
        CREATE TABLE IF NOT EXISTS engineering_ingest_receipts (
          idempotency_key TEXT PRIMARY KEY,
          received_at TEXT NOT NULL
        );
        ",
    )
}

fn up_010(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS harness_run_events (
          id TEXT PRIMARY KEY,
          trace_id TEXT,
          span_id TEXT,
          service_name TEXT NOT NULL,
          lane TEXT NOT NULL,
          status TEXT NOT NULL,
          started_at TEXT NOT NULL,
          finished_at TEXT NOT NULL,
          duration_ms INTEGER NOT NULL DEFAULT 0,
          error_kind TEXT,
          run_url TEXT,
          domain TEXT,
          scenario TEXT,
          worktree_id TEXT,
          commit_sha TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_harness_run_events_lane_finished
        ON harness_run_events (lane, finished_at DESC);
        CREATE INDEX IF NOT EXISTS idx_harness_run_events_domain_finished
        ON harness_run_events (domain, finished_at DESC);
        ",
    )
}

fn up_011(connection: &Connection) -> rusqlite::Result<()> {
    let present: HashSet<String> = {
        let mut statement = connection.prepare("PRAGMA table_info(harness_run_events)")?;
        let rows = statement.query_map([], |row| row.get::<_, String>("name"))?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    for column in V3_COLUMNS {
        if !present.contains(column) {
            connection.execute_batch(&format!(
                "ALTER TABLE harness_run_events ADD COLUMN {column} TEXT"
            ))?;
        }
    }
    connection.execute_batch(
        "
        CREATE INDEX IF NOT EXISTS idx_harness_run_events_domain_finished
        ON harness_run_events (domain, finished_at DESC);
        CREATE INDEX IF NOT EXISTS idx_harness_run_events_scenario_finished
        ON harness_run_events (scenario, finished_at DESC);
        CREATE INDEX IF NOT EXISTS idx_harness_run_events_worktree_finished
        ON harness_run_events (worktree_id, finished_at DESC);
        CREATE INDEX IF NOT EXISTS idx_harness_run_events_commit_finished
        ON harness_run_events (commit_sha, finished_at DESC);
        ",
    )
}

fn up_012(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS engineering_rollout_baselines (
          id TEXT PRIMARY KEY,
          window_start TEXT NOT NULL,
          window_end TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          source TEXT NOT NULL,
          baseline_hash TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_engineering_rollout_baselines_created
        ON engineering_rollout_baselines (created_at DESC);
        CREATE TABLE IF NOT EXISTS engineering_rollout_gate_runs (
          id TEXT PRIMARY KEY,
          phase_id TEXT,
          status TEXT NOT NULL CHECK (status IN ('pass', 'fail', 'unknown')),
          payload_json TEXT NOT NULL,
          generated_at TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_engineering_rollout_gate_runs_generated
        ON engineering_rollout_gate_runs (generated_at DESC);
        ",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const ENGINEERING_TABLES: [&str; 6] = [
        "engineering_metrics_snapshots",
        "engineering_pr_facts",
        "engineering_ingest_receipts",
        "harness_run_events",
        "engineering_rollout_baselines",
        "engineering_rollout_gate_runs",
    ];

    fn column_names(connection: &Connection, table: &str) -> Vec<String> {
        let mut statement = connection
            .prepare(&format!("PRAGMA table_info({table})"))
            .expect("pragma");
        let names: Vec<String> = statement
            .query_map([], |row| row.get::<_, String>("name"))
            .expect("query")
            .map(|name| name.expect("row"))
            .collect();
        names
    }

    #[test]
    fn a_fresh_database_gets_the_tables_and_the_ledger_rows() {
        let mut connection = Connection::open_in_memory().expect("open");
        let applied = run_engineering_migrations(&mut connection).expect("migrate");
        assert_eq!(applied, vec!["009", "010", "011", "012"]);

        for table in ENGINEERING_TABLES {
            assert!(
                !column_names(&connection, table).is_empty(),
                "{table} exists"
            );
        }

        let mut statement = connection
            .prepare("SELECT id, name FROM _migrations ORDER BY id")
            .expect("ledger");
        let ledger: Vec<(String, String)> = statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .expect("query")
            .map(|row| row.expect("row"))
            .collect();
        assert_eq!(
            ledger,
            vec![
                (
                    "009".to_string(),
                    "add_engineering_metrics_tables".to_string()
                ),
                (
                    "010".to_string(),
                    "add_harness_run_events_table".to_string()
                ),
                (
                    "011".to_string(),
                    "extend_harness_run_events_v3".to_string()
                ),
                (
                    "012".to_string(),
                    "add_engineering_rollout_tables".to_string()
                ),
            ]
        );
    }

    #[test]
    fn a_second_run_applies_nothing() {
        let mut connection = Connection::open_in_memory().expect("open");
        run_engineering_migrations(&mut connection).expect("first");
        let applied = run_engineering_migrations(&mut connection).expect("second");
        assert!(applied.is_empty());
    }

    #[test]
    fn a_harness_table_from_before_011_gains_the_v3_columns() {
        let mut connection = Connection::open_in_memory().expect("open");
        connection.execute_batch(LEDGER_DDL).expect("ledger");
        connection
            .execute_batch(
                "CREATE TABLE harness_run_events (
                   id TEXT PRIMARY KEY, trace_id TEXT, span_id TEXT,
                   service_name TEXT NOT NULL, lane TEXT NOT NULL, status TEXT NOT NULL,
                   started_at TEXT NOT NULL, finished_at TEXT NOT NULL,
                   duration_ms INTEGER NOT NULL DEFAULT 0, error_kind TEXT, run_url TEXT,
                   created_at TEXT NOT NULL DEFAULT (datetime('now'))
                 );
                 INSERT INTO _migrations (id, name) VALUES ('009', 'add_engineering_metrics_tables');
                 INSERT INTO _migrations (id, name) VALUES ('010', 'add_harness_run_events_table');",
            )
            .expect("legacy table");

        let applied = run_engineering_migrations(&mut connection).expect("migrate");
        assert_eq!(applied, vec!["011", "012"]);
        let columns = column_names(&connection, "harness_run_events");
        for column in V3_COLUMNS {
            assert!(columns.iter().any(|name| name == column), "{column}");
        }
    }

    #[test]
    fn the_schema_constraints_hold() {
        let mut connection = Connection::open_in_memory().expect("open");
        run_engineering_migrations(&mut connection).expect("migrate");

        let bad_window = connection.execute(
            "INSERT INTO engineering_metrics_snapshots (id, window_days, payload_json, source, generated_at)
             VALUES ('s', 14, '{}', 'snapshot', '2026-06-10T00:00:00.000Z')",
            [],
        );
        assert!(bad_window.is_err(), "window_days is limited to 7 and 30");

        let bad_status = connection.execute(
            "INSERT INTO engineering_rollout_gate_runs (id, status, payload_json, generated_at)
             VALUES ('g', 'maybe', '{}', '2026-06-10T00:00:00.000Z')",
            [],
        );
        assert!(bad_status.is_err(), "gate status is pass, fail or unknown");
    }
}
