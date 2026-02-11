import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';

type SQLParam = string | number | null | bigint | Uint8Array;
import type {
  WorkerRepository,
  WorkerTaskRecord,
  WorkerTaskStatus,
  WorkerStepRecord,
  WorkerStepStatus,
  WorkerArtifactRecord,
  ApprovalRule,
  CreateTaskInput,
  SaveStepInput,
  SaveArtifactInput,
} from './workerTypes';

// ─── Row Mappers ─────────────────────────────────────────────

function toTask(row: Record<string, unknown>): WorkerTaskRecord {
  return {
    id: row.id as string,
    title: row.title as string,
    objective: row.objective as string,
    status: row.status as WorkerTaskStatus,
    priority: row.priority as WorkerTaskRecord['priority'],
    originPlatform: row.origin_platform as WorkerTaskRecord['originPlatform'],
    originConversation: row.origin_conversation as string,
    originExternalChat: (row.origin_external_chat as string) || null,
    currentStep: (row.current_step as number) || 0,
    totalSteps: (row.total_steps as number) || 0,
    resultSummary: (row.result_summary as string) || null,
    errorMessage: (row.error_message as string) || null,
    resumable: row.resumable === 1,
    lastCheckpoint: (row.last_checkpoint as string) || null,
    workspacePath: (row.workspace_path as string) || null,
    workspaceType: (row.workspace_type as WorkerTaskRecord['workspaceType']) || 'general',
    createdAt: row.created_at as string,
    startedAt: (row.started_at as string) || null,
    completedAt: (row.completed_at as string) || null,
  };
}

function toStep(row: Record<string, unknown>): WorkerStepRecord {
  return {
    id: row.id as string,
    taskId: row.task_id as string,
    stepIndex: row.step_index as number,
    description: row.description as string,
    status: row.status as WorkerStepStatus,
    output: (row.output as string) || null,
    toolCalls: (row.tool_calls as string) || null,
    startedAt: (row.started_at as string) || null,
    completedAt: (row.completed_at as string) || null,
  };
}

function toArtifact(row: Record<string, unknown>): WorkerArtifactRecord {
  return {
    id: row.id as string,
    taskId: row.task_id as string,
    name: row.name as string,
    type: row.type as WorkerArtifactRecord['type'],
    content: row.content as string,
    mimeType: (row.mime_type as string) || null,
    createdAt: row.created_at as string,
  };
}

function toApprovalRule(row: Record<string, unknown>): ApprovalRule {
  return {
    id: row.id as string,
    commandPattern: row.command_pattern as string,
    createdAt: row.created_at as string,
  };
}

// ─── SQLite Implementation ───────────────────────────────────

export class SqliteWorkerRepository implements WorkerRepository {
  private readonly db: ReturnType<typeof Database>;

  constructor(dbPath = process.env.WORKER_DB_PATH || '.local/worker.db') {
    if (dbPath === ':memory:') {
      this.db = new Database(':memory:');
    } else {
      const fullPath = path.isAbsolute(dbPath) ? dbPath : path.join(process.cwd(), dbPath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      this.db = new Database(fullPath);
    }
    this.db.exec('PRAGMA journal_mode = WAL');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS worker_tasks (
        id                   TEXT PRIMARY KEY,
        title                TEXT NOT NULL,
        objective            TEXT NOT NULL,
        status               TEXT NOT NULL DEFAULT 'queued',
        priority             TEXT NOT NULL DEFAULT 'normal',
        origin_platform      TEXT NOT NULL,
        origin_conversation  TEXT NOT NULL,
        origin_external_chat TEXT,
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

    // Safe migration for existing databases
    try {
      this.db.exec(`ALTER TABLE worker_tasks ADD COLUMN workspace_path TEXT`);
    } catch {
      /* column already exists */
    }
    try {
      this.db.exec(`ALTER TABLE worker_tasks ADD COLUMN workspace_type TEXT DEFAULT 'general'`);
    } catch {
      /* column already exists */
    }

    this.db.exec(`
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

    this.db.exec(`
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

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS worker_approval_rules (
        id              TEXT PRIMARY KEY,
        command_pattern  TEXT NOT NULL UNIQUE,
        created_at      TEXT NOT NULL
      );
    `);
  }

  // ─── Tasks ──────────────────────────────────────────────────

  createTask(input: CreateTaskInput): WorkerTaskRecord {
    const id = `task-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();

    this.db
      .prepare(
        `
      INSERT INTO worker_tasks (id, title, objective, status, priority,
        origin_platform, origin_conversation, origin_external_chat,
        workspace_type, created_at)
      VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        id,
        input.title,
        input.objective,
        input.priority || 'normal',
        input.originPlatform,
        input.originConversation,
        input.originExternalChat || null,
        input.workspaceType || 'general',
        now,
      );

    return this.getTask(id)!;
  }

  getTask(id: string): WorkerTaskRecord | null {
    const row = this.db.prepare('SELECT * FROM worker_tasks WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? toTask(row) : null;
  }

  updateStatus(
    id: string,
    status: WorkerTaskStatus,
    extra?: { summary?: string; error?: string },
  ): void {
    const now = new Date().toISOString();
    const sets = ['status = ?'];
    const params: SQLParam[] = [status];

    if (status === 'executing' || status === 'planning') {
      sets.push('started_at = COALESCE(started_at, ?)');
      params.push(now);
    }
    if (status === 'completed' || status === 'failed' || status === 'cancelled') {
      sets.push('completed_at = ?');
      params.push(now);
    }
    if (extra?.summary) {
      sets.push('result_summary = ?');
      params.push(extra.summary);
    }
    if (extra?.error) {
      sets.push('error_message = ?');
      params.push(extra.error);
    }

    params.push(id);
    this.db.prepare(`UPDATE worker_tasks SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  listTasks(filter?: { status?: WorkerTaskStatus; limit?: number }): WorkerTaskRecord[] {
    let sql = 'SELECT * FROM worker_tasks';
    const params: SQLParam[] = [];

    if (filter?.status) {
      sql += ' WHERE status = ?';
      params.push(filter.status);
    }
    sql += ' ORDER BY created_at DESC';
    if (filter?.limit) {
      sql += ' LIMIT ?';
      params.push(filter.limit);
    }

    const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    return rows.map(toTask);
  }

  cancelTask(id: string): void {
    this.updateStatus(id, 'cancelled');
  }

  deleteTask(id: string): void {
    this.db.prepare(`DELETE FROM worker_artifacts WHERE task_id = ?`).run(id);
    this.db.prepare(`DELETE FROM worker_steps WHERE task_id = ?`).run(id);
    this.db.prepare(`DELETE FROM worker_tasks WHERE id = ?`).run(id);
  }

  getNextQueuedTask(): WorkerTaskRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM worker_tasks WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1`)
      .get() as Record<string, unknown> | undefined;
    return row ? toTask(row) : null;
  }

  getActiveTask(): WorkerTaskRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM worker_tasks WHERE status IN ('planning', 'executing', 'clarifying', 'waiting_approval') LIMIT 1`,
      )
      .get() as Record<string, unknown> | undefined;
    return row ? toTask(row) : null;
  }

  markInterrupted(id: string): void {
    this.db
      .prepare(`UPDATE worker_tasks SET status = 'interrupted', resumable = 1 WHERE id = ?`)
      .run(id);
  }

  saveCheckpoint(id: string, checkpoint: Record<string, unknown>): void {
    this.db
      .prepare(`UPDATE worker_tasks SET last_checkpoint = ? WHERE id = ?`)
      .run(JSON.stringify(checkpoint), id);
  }

  setCurrentStep(id: string, stepIndex: number): void {
    this.db.prepare(`UPDATE worker_tasks SET current_step = ? WHERE id = ?`).run(stepIndex, id);
  }

  setTotalSteps(id: string, total: number): void {
    this.db.prepare(`UPDATE worker_tasks SET total_steps = ? WHERE id = ?`).run(total, id);
  }

  setWorkspacePath(id: string, wsPath: string): void {
    this.db.prepare(`UPDATE worker_tasks SET workspace_path = ? WHERE id = ?`).run(wsPath, id);
  }

  // ─── Steps ──────────────────────────────────────────────────

  saveSteps(taskId: string, steps: SaveStepInput[]): void {
    const stmt = this.db.prepare(`
      INSERT INTO worker_steps (id, task_id, step_index, description, status)
      VALUES (?, ?, ?, ?, 'pending')
    `);

    for (const step of steps) {
      const id = `step-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
      stmt.run(id, taskId, step.stepIndex, step.description);
    }

    this.setTotalSteps(taskId, steps.length);
  }

  getSteps(taskId: string): WorkerStepRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM worker_steps WHERE task_id = ? ORDER BY step_index ASC')
      .all(taskId) as Array<Record<string, unknown>>;
    return rows.map(toStep);
  }

  updateStepStatus(
    stepId: string,
    status: WorkerStepStatus,
    output?: string,
    toolCalls?: string,
  ): void {
    const now = new Date().toISOString();
    const sets = ['status = ?'];
    const params: SQLParam[] = [status];

    if (status === 'running') {
      sets.push('started_at = ?');
      params.push(now);
    }
    if (status === 'completed' || status === 'failed') {
      sets.push('completed_at = ?');
      params.push(now);
    }
    if (output !== undefined) {
      sets.push('output = ?');
      params.push(output);
    }
    if (toolCalls !== undefined) {
      sets.push('tool_calls = ?');
      params.push(toolCalls);
    }

    params.push(stepId);
    this.db.prepare(`UPDATE worker_steps SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  // ─── Artifacts ──────────────────────────────────────────────

  saveArtifact(input: SaveArtifactInput): WorkerArtifactRecord {
    const id = `art-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();

    this.db
      .prepare(
        `
      INSERT INTO worker_artifacts (id, task_id, name, type, content, mime_type, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(id, input.taskId, input.name, input.type, input.content, input.mimeType || null, now);

    const row = this.db.prepare('SELECT * FROM worker_artifacts WHERE id = ?').get(id) as Record<
      string,
      unknown
    >;
    return toArtifact(row);
  }

  getArtifacts(taskId: string): WorkerArtifactRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM worker_artifacts WHERE task_id = ? ORDER BY created_at ASC')
      .all(taskId) as Array<Record<string, unknown>>;
    return rows.map(toArtifact);
  }

  // ─── Approval Rules ────────────────────────────────────────

  addApprovalRule(commandPattern: string): void {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
      INSERT OR IGNORE INTO worker_approval_rules (id, command_pattern, created_at)
      VALUES (?, ?, ?)
    `,
      )
      .run(id, commandPattern, now);
  }

  removeApprovalRule(id: string): void {
    this.db.prepare('DELETE FROM worker_approval_rules WHERE id = ?').run(id);
  }

  isCommandApproved(command: string): boolean {
    // Check exact match first
    const exact = this.db
      .prepare(`SELECT 1 FROM worker_approval_rules WHERE command_pattern = ?`)
      .get(command);
    if (exact) return true;

    // Check glob patterns (simple prefix matching with *)
    const rules = this.db
      .prepare(`SELECT command_pattern FROM worker_approval_rules WHERE command_pattern LIKE '%*%'`)
      .all() as Array<Record<string, unknown>>;

    for (const rule of rules) {
      const pattern = rule.command_pattern as string;
      const prefix = pattern.replace(/\*.*$/, '');
      if (command.startsWith(prefix)) return true;
    }

    return false;
  }

  listApprovalRules(): ApprovalRule[] {
    const rows = this.db
      .prepare('SELECT * FROM worker_approval_rules ORDER BY created_at ASC')
      .all() as Array<Record<string, unknown>>;
    return rows.map(toApprovalRule);
  }
}

// ─── Singleton ───────────────────────────────────────────────

let instance: SqliteWorkerRepository | null = null;

export function getWorkerRepository(): SqliteWorkerRepository {
  if (!instance) {
    instance = new SqliteWorkerRepository();
  }
  return instance;
}
