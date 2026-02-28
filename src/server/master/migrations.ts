import type BetterSqlite3 from 'better-sqlite3';

function ensureColumn(
  db: ReturnType<typeof BetterSqlite3>,
  table: string,
  column: string,
  definition: string,
): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
  const hasColumn = rows.some((row) => String(row.name || '') === column);
  if (!hasColumn) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export function runMasterMigrations(db: ReturnType<typeof BetterSqlite3>): void {
  db.exec(`
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
  `);

  ensureColumn(db, 'master_runs', 'cancelled_at', 'TEXT');
  ensureColumn(db, 'master_runs', 'cancel_reason', 'TEXT');
  ensureColumn(db, 'master_runs', 'pending_approval_action_type', 'TEXT');
}
