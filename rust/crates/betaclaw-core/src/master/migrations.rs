//! Port of `src/server/master/migrations.ts:1-306`.
//!
//! # Statement-for-statement parity
//!
//! `runMasterMigrations` is one `db.exec` block of idempotent `CREATE ... IF
//! NOT EXISTS` DDL followed by eight `ensureColumn` probes and a final unique
//! index. The port reproduces the block verbatim — every table, index and
//! column declaration in source order — because those table names and column
//! names are the storage contract shared with the TypeScript backend: the
//! default `master.db` is opened by both implementations.
//!
//! There is **no `_migrations` ledger**. Like
//! `messages_store::migrations`, the ladder only adds, so it is safe to run on
//! every open and cannot be queried for "what has been applied". The port does
//! not invent one: an extra bookkeeping table would change what the TypeScript
//! backend sees when it opens the same file.
//!
//! # `ensureColumn`
//!
//! `ensureColumn` (`migrations.ts:3-14`) reads `PRAGMA table_info(<table>)` and
//! only issues the `ALTER TABLE ADD COLUMN` when the column is absent. It is
//! reproduced by [`ensure_column`] and used for the additive upgrades that a
//! release before those columns existed still needs.

use rusqlite::Connection;

/// One `db.exec` block from `migrations.ts:17-290`.
///
/// Kept as a single string with the source indentation so a reviewer can diff
/// it against the TypeScript template literal line by line.
const SCHEMA: &str = r#"
    CREATE TABLE IF NOT EXISTS master_runs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      title TEXT NOT NULL,
      contract TEXT NOT NULL,
      status TEXT NOT NULL,
      progress INTEGER NOT NULL DEFAULT 0,
      verification_passed INTEGER NOT NULL DEFAULT 0,
      result_bundle TEXT,
      last_error TEXT,
      paused_for_approval INTEGER NOT NULL DEFAULT 0,
      cancelled_at TEXT,
      cancel_reason TEXT,
      owner_id TEXT,
      lease_expires_at TEXT,
      heartbeat_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_master_runs_scope ON master_runs (user_id, workspace_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_master_runs_scope_status ON master_runs (user_id, workspace_id, status, updated_at DESC);

    CREATE TABLE IF NOT EXISTS master_steps (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      phase TEXT NOT NULL,
      status TEXT NOT NULL,
      input TEXT,
      output TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_master_steps_run_seq ON master_steps (run_id, seq);

    CREATE TABLE IF NOT EXISTS master_feedback (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      rating INTEGER NOT NULL,
      policy TEXT NOT NULL,
      comment TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS master_notes (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_master_notes_scope ON master_notes (user_id, workspace_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS master_reminders (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      remind_at TEXT NOT NULL,
      cron_expression TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_master_reminders_scope ON master_reminders (user_id, workspace_id, remind_at ASC);
    CREATE TABLE IF NOT EXISTS master_subagent_jobs (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      capability TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL,
      priority TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      timeout_ms INTEGER NOT NULL DEFAULT 120000,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_master_subagent_jobs_run ON master_subagent_jobs (run_id, status, updated_at DESC);

    CREATE TABLE IF NOT EXISTS master_subagent_events (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_master_subagent_events_job ON master_subagent_events (job_id, created_at ASC);

    CREATE TABLE IF NOT EXISTS master_action_ledger (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      action_type TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL,
      result_payload TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_master_action_ledger_scope ON master_action_ledger (run_id, state, updated_at DESC);

    CREATE TABLE IF NOT EXISTS master_approval_rules (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      action_type TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      decision TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (user_id, workspace_id, action_type, fingerprint)
    );

    CREATE TABLE IF NOT EXISTS master_approval_requests (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      action_type TEXT NOT NULL,
      summary TEXT NOT NULL,
      prompt TEXT NOT NULL,
      host TEXT,
      cwd TEXT,
      resolved_path TEXT,
      fingerprint TEXT NOT NULL,
      risk_level TEXT NOT NULL,
      status TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      decision TEXT,
      decision_reason TEXT,
      decided_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_master_approval_requests_scope
      ON master_approval_requests (user_id, workspace_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_master_approval_requests_run
      ON master_approval_requests (run_id, status, updated_at DESC);

    CREATE TABLE IF NOT EXISTS master_tool_policies (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      security TEXT NOT NULL,
      ask TEXT NOT NULL,
      allowlist TEXT NOT NULL DEFAULT '[]',
      updated_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (user_id, workspace_id)
    );
    CREATE TABLE IF NOT EXISTS master_subagent_sessions (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      status TEXT NOT NULL,
      title TEXT NOT NULL,
      prompt TEXT NOT NULL,
      assigned_tools TEXT NOT NULL DEFAULT '[]',
      owner_id TEXT,
      lease_expires_at TEXT,
      heartbeat_at TEXT,
      latest_event_at TEXT,
      result_summary TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_master_subagent_sessions_run
      ON master_subagent_sessions (run_id, status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_master_subagent_sessions_scope
      ON master_subagent_sessions (user_id, workspace_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS master_capability_scores (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      capability TEXT NOT NULL,
      confidence REAL NOT NULL,
      last_verified_at TEXT,
      benchmark_summary TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL,
      UNIQUE (user_id, workspace_id, capability)
    );

    CREATE TABLE IF NOT EXISTS master_capability_proposals (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      title TEXT NOT NULL,
      capability_key TEXT NOT NULL,
      status TEXT NOT NULL,
      proposal TEXT NOT NULL,
      fallback_plan TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS master_toolforge_artifacts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      name TEXT NOT NULL,
      spec TEXT NOT NULL,
      manifest TEXT NOT NULL,
      test_summary TEXT NOT NULL,
      risk_report TEXT NOT NULL,
      status TEXT NOT NULL,
      published_globally INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS master_connector_secrets (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      key_ref TEXT NOT NULL,
      encrypted_payload TEXT NOT NULL,
      issued_at TEXT,
      expires_at TEXT,
      revoked_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (user_id, workspace_id, provider, key_ref)
    );

    CREATE TABLE IF NOT EXISTS master_audit_events (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      category TEXT NOT NULL,
      action TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_master_audit_scope
      ON master_audit_events (user_id, workspace_id, created_at DESC);
  "#;

/// `ensureColumn` from `migrations.ts:3-14`.
///
/// `PRAGMA table_info(<table>)` probe first; the `ALTER TABLE` only runs when
/// the column is missing. `table`, `column` and `definition` are quoted into
/// the DDL. Callers only ever pass the fixed literals from the migration, never
/// user input.
pub fn ensure_column(
    connection: &Connection,
    table: &str,
    column: &str,
    definition: &str,
) -> rusqlite::Result<()> {
    if has_column(connection, table, column)? {
        return Ok(());
    }
    connection.execute_batch(&format!(
        "ALTER TABLE {table} ADD COLUMN {column} {definition}"
    ))
}

/// `hasColumn` probe from `migrations.ts:9-11`.
///
/// Reads the `name` column of `PRAGMA table_info(<table>)` and compares it to
/// the requested column.
pub fn has_column(connection: &Connection, table: &str, column: &str) -> rusqlite::Result<bool> {
    let mut statement = connection.prepare(&format!("PRAGMA table_info({table})"))?;
    let mut rows = statement.query([])?;
    while let Some(row) = rows.next()? {
        let name: Option<String> = row.get(1)?;
        if name.as_deref() == Some(column) {
            return Ok(true);
        }
    }
    Ok(false)
}

/// `runMasterMigrations` from `migrations.ts:16-306`.
///
/// Runs unconditionally on open, exactly like the source, and is safe to call
/// repeatedly.
pub fn run_master_migrations(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch(SCHEMA)?;

    ensure_column(connection, "master_runs", "cancelled_at", "TEXT")?;
    ensure_column(connection, "master_runs", "cancel_reason", "TEXT")?;
    ensure_column(
        connection,
        "master_runs",
        "pending_approval_action_type",
        "TEXT",
    )?;
    ensure_column(connection, "master_runs", "owner_id", "TEXT")?;
    ensure_column(connection, "master_runs", "lease_expires_at", "TEXT")?;
    ensure_column(connection, "master_runs", "heartbeat_at", "TEXT")?;
    ensure_column(
        connection,
        "master_approval_requests",
        "action_type",
        "TEXT NOT NULL DEFAULT ''",
    )?;
    ensure_column(
        connection,
        "master_approval_requests",
        "prompt",
        "TEXT NOT NULL DEFAULT ''",
    )?;

    // Idempotency: one feedback record per (run, user) — upsert-safe.
    connection.execute_batch(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_master_feedback_run_user
         ON master_feedback (run_id, user_id)",
    )?;

    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{open, OpenOptions};

    fn memory() -> Connection {
        open(OpenOptions::new(":memory:")).expect("open in-memory database")
    }

    #[test]
    fn creates_every_master_table() {
        let connection = memory();
        run_master_migrations(&connection).unwrap();
        for table in [
            "master_runs",
            "master_steps",
            "master_feedback",
            "master_notes",
            "master_reminders",
            "master_subagent_jobs",
            "master_subagent_events",
            "master_action_ledger",
            "master_approval_rules",
            "master_approval_requests",
            "master_tool_policies",
            "master_subagent_sessions",
            "master_capability_scores",
            "master_capability_proposals",
            "master_toolforge_artifacts",
            "master_connector_secrets",
            "master_audit_events",
        ] {
            assert!(
                has_column(&connection, table, "id").unwrap(),
                "table {table} missing"
            );
        }
    }

    #[test]
    fn runs_twice_without_error() {
        let connection = memory();
        run_master_migrations(&connection).unwrap();
        run_master_migrations(&connection).unwrap();
    }

    #[test]
    fn ensure_column_is_additive_only() {
        let connection = memory();
        connection
            .execute_batch("CREATE TABLE t (id TEXT PRIMARY KEY)")
            .unwrap();
        ensure_column(&connection, "t", "extra", "TEXT").unwrap();
        assert!(has_column(&connection, "t", "extra").unwrap());
        // A second call must not fail on the now-existing column.
        ensure_column(&connection, "t", "extra", "TEXT").unwrap();
        assert!(!has_column(&connection, "t", "missing").unwrap());
    }

    #[test]
    fn feedback_unique_index_is_one_per_run_and_user() {
        let connection = memory();
        run_master_migrations(&connection).unwrap();
        connection
            .execute(
                "INSERT INTO master_feedback (id, run_id, user_id, workspace_id, rating, policy, created_at)
                 VALUES ('f1', 'r1', 'u1', 'w1', 1, 'safe', 't')",
                [],
            )
            .unwrap();
        let duplicate = connection.execute(
            "INSERT INTO master_feedback (id, run_id, user_id, workspace_id, rating, policy, created_at)
             VALUES ('f2', 'r1', 'u1', 'w1', 2, 'fast', 't')",
            [],
        );
        assert!(
            duplicate.is_err(),
            "the unique index must reject a duplicate"
        );
    }
}
