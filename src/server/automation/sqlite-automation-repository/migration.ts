import type { SqliteDb } from './types';

export function migrateAutomationSchema(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS automation_rules (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      cron_expression TEXT NOT NULL,
      timezone TEXT NOT NULL,
      prompt TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      next_run_at TEXT,
      last_run_at TEXT,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_automation_rules_user
      ON automation_rules (user_id, updated_at DESC);

    CREATE INDEX IF NOT EXISTS idx_automation_rules_due
      ON automation_rules (enabled, next_run_at);

    CREATE TABLE IF NOT EXISTS automation_runs (
      id TEXT PRIMARY KEY,
      rule_id TEXT NOT NULL REFERENCES automation_rules(id),
      user_id TEXT NOT NULL,
      trigger_source TEXT NOT NULL,
      scheduled_for TEXT NOT NULL,
      run_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT,
      error_message TEXT,
      result_summary TEXT,
      started_at TEXT,
      finished_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_automation_runs_rule
      ON automation_runs (rule_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_automation_runs_due
      ON automation_runs (status, next_attempt_at);

    CREATE TABLE IF NOT EXISTS automation_dead_letters (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      rule_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      payload TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS automation_scheduler_lease (
      singleton_key TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL,
      heartbeat_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  try {
    db.exec(`ALTER TABLE automation_rules ADD COLUMN flow_graph TEXT;`);
  } catch {
    // Spalte existiert bereits.
  }
}
