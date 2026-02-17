import type BetterSqlite3 from 'better-sqlite3';

/**
 * Database migrations for the worker module.
 * Contains all schema definitions and migration logic.
 */

export function runMigrations(db: BetterSqlite3.Database): void {
  // Core tables
  createWorkerTasksTable(db);
  createWorkerStepsTable(db);
  createWorkerArtifactsTable(db);
  createWorkerApprovalRulesTable(db);
  createWorkerTaskActivitiesTable(db);

  // Orchestra tables
  createWorkerFlowTemplatesTable(db);
  createWorkerFlowDraftsTable(db);
  createWorkerFlowPublishedTable(db);
  createWorkerRunsTable(db);
  createWorkerRunNodesTable(db);
  createWorkerSubagentSessionsTable(db);
  createWorkerTaskDeliverablesTable(db);
  createWorkerUserSettingsTable(db);

  // Column migrations (safe for existing databases)
  migrateWorkerTasksColumns(db);
}

function createWorkerTasksTable(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS worker_tasks (
      id                   TEXT PRIMARY KEY,
      title                TEXT NOT NULL,
      objective            TEXT NOT NULL,
      status               TEXT NOT NULL DEFAULT 'queued',
      priority             TEXT NOT NULL DEFAULT 'normal',
      origin_platform      TEXT NOT NULL,
      origin_conversation  TEXT NOT NULL,
      origin_external_chat TEXT,
      user_id              TEXT,
      current_step         INTEGER DEFAULT 0,
      total_steps          INTEGER DEFAULT 0,
      result_summary       TEXT,
      error_message        TEXT,
      resumable            INTEGER DEFAULT 0,
      last_checkpoint      TEXT,
      workspace_path       TEXT,
      workspace_type       TEXT DEFAULT 'general',
      created_at           TEXT NOT NULL,
      started_at           TEXT,
      completed_at         TEXT
    );
  `);
}

function migrateWorkerTasksColumns(db: BetterSqlite3.Database): void {
  const columns = [
    { name: 'workspace_path', type: 'TEXT' },
    { name: 'workspace_type', type: "TEXT DEFAULT 'general'" },
    { name: 'user_id', type: 'TEXT' },
    { name: 'flow_published_id', type: 'TEXT' },
    { name: 'current_run_id', type: 'TEXT' },
    { name: 'assigned_persona_id', type: 'TEXT' },
    { name: 'planning_messages', type: 'TEXT' },
    { name: 'planning_complete', type: 'INTEGER DEFAULT 0' },
  ];

  for (const column of columns) {
    try {
      db.exec(`ALTER TABLE worker_tasks ADD COLUMN ${column.name} ${column.type}`);
    } catch {
      // Column already exists
    }
  }
}

function createWorkerStepsTable(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS worker_steps (
      id           TEXT PRIMARY KEY,
      task_id      TEXT NOT NULL REFERENCES worker_tasks(id),
      step_index   INTEGER NOT NULL,
      description  TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'pending',
      output       TEXT,
      tool_calls   TEXT,
      started_at   TEXT,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_steps_task ON worker_steps(task_id, step_index);
  `);
}

function createWorkerArtifactsTable(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS worker_artifacts (
      id         TEXT PRIMARY KEY,
      task_id    TEXT NOT NULL REFERENCES worker_tasks(id),
      name       TEXT NOT NULL,
      type       TEXT NOT NULL,
      content    TEXT NOT NULL,
      mime_type  TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_artifacts_task ON worker_artifacts(task_id);
  `);
}

function createWorkerApprovalRulesTable(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS worker_approval_rules (
      id              TEXT PRIMARY KEY,
      command_pattern  TEXT NOT NULL UNIQUE,
      created_at      TEXT NOT NULL
    );
  `);
}

function createWorkerTaskActivitiesTable(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS worker_task_activities (
      id         TEXT PRIMARY KEY,
      task_id    TEXT NOT NULL REFERENCES worker_tasks(id),
      type       TEXT NOT NULL,
      message    TEXT NOT NULL,
      metadata   TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_activities_task ON worker_task_activities(task_id, created_at);
  `);
}

function createWorkerFlowTemplatesTable(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS worker_flow_templates (
      id             TEXT PRIMARY KEY,
      user_id        TEXT NOT NULL,
      workspace_type TEXT NOT NULL,
      name           TEXT NOT NULL,
      description    TEXT,
      template_json  TEXT NOT NULL,
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_flow_templates_user_workspace
      ON worker_flow_templates(user_id, workspace_type);
  `);
}

function createWorkerFlowDraftsTable(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS worker_flow_drafts (
      id             TEXT PRIMARY KEY,
      template_id    TEXT,
      user_id        TEXT NOT NULL,
      workspace_type TEXT NOT NULL,
      name           TEXT NOT NULL,
      graph_json     TEXT NOT NULL,
      status         TEXT NOT NULL DEFAULT 'draft',
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_flow_drafts_user_workspace
      ON worker_flow_drafts(user_id, workspace_type);
  `);
}

function createWorkerFlowPublishedTable(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS worker_flow_published (
      id             TEXT PRIMARY KEY,
      draft_id       TEXT,
      template_id    TEXT,
      user_id        TEXT NOT NULL,
      workspace_type TEXT NOT NULL,
      name           TEXT NOT NULL,
      graph_json     TEXT NOT NULL,
      version        INTEGER NOT NULL DEFAULT 1,
      created_at     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_flow_published_user_workspace
      ON worker_flow_published(user_id, workspace_type, created_at DESC);
  `);
}

function createWorkerRunsTable(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS worker_runs (
      id                TEXT PRIMARY KEY,
      task_id           TEXT NOT NULL REFERENCES worker_tasks(id),
      user_id           TEXT NOT NULL,
      flow_published_id TEXT NOT NULL REFERENCES worker_flow_published(id),
      status            TEXT NOT NULL DEFAULT 'pending',
      error_message     TEXT,
      created_at        TEXT NOT NULL,
      started_at        TEXT,
      completed_at      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_worker_runs_task_created
      ON worker_runs(task_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_worker_runs_user_status
      ON worker_runs(user_id, status);
  `);
}

function createWorkerRunNodesTable(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS worker_run_nodes (
      id             TEXT PRIMARY KEY,
      run_id         TEXT NOT NULL REFERENCES worker_runs(id),
      node_id        TEXT NOT NULL,
      persona_id     TEXT,
      status         TEXT NOT NULL DEFAULT 'pending',
      output_summary TEXT,
      error_message  TEXT,
      metadata       TEXT,
      started_at     TEXT,
      completed_at   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_worker_run_nodes_run
      ON worker_run_nodes(run_id, node_id);
  `);
}

function createWorkerSubagentSessionsTable(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS worker_subagent_sessions (
      id           TEXT PRIMARY KEY,
      task_id      TEXT NOT NULL REFERENCES worker_tasks(id),
      run_id       TEXT REFERENCES worker_runs(id),
      node_id      TEXT,
      user_id      TEXT NOT NULL,
      persona_id   TEXT,
      status       TEXT NOT NULL DEFAULT 'started',
      session_ref  TEXT,
      metadata     TEXT,
      started_at   TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_subagent_sessions_task_started
      ON worker_subagent_sessions(task_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_subagent_sessions_user_status
      ON worker_subagent_sessions(user_id, status);
  `);
}

function createWorkerTaskDeliverablesTable(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS worker_task_deliverables (
      id         TEXT PRIMARY KEY,
      task_id    TEXT NOT NULL REFERENCES worker_tasks(id),
      run_id     TEXT REFERENCES worker_runs(id),
      node_id    TEXT,
      type       TEXT NOT NULL,
      name       TEXT NOT NULL,
      content    TEXT NOT NULL,
      mime_type  TEXT,
      metadata   TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_deliverables_task_created
      ON worker_task_deliverables(task_id, created_at DESC);
  `);
}

function createWorkerUserSettingsTable(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS worker_user_settings (
      user_id                TEXT PRIMARY KEY,
      default_workspace_root TEXT,
      updated_at             TEXT NOT NULL
    );
  `);
}
