import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import BetterSqlite3 from 'better-sqlite3';
import { LEGACY_LOCAL_USER_ID } from '../auth/constants';

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
  SaveActivityInput,
  TaskActivityRecord,
} from './workerTypes';
import type {
  WorkerFlowDraftRecord,
  WorkerFlowPublishedRecord,
  WorkerRunNodeRecord,
  WorkerRunRecord,
  WorkerSubagentSessionRecord,
  WorkerTaskDeliverableRecord,
} from './orchestraTypes';
import { toApprovalRule, toArtifact, toStep, toTask, toActivity } from './workerRowMappers';

// ─── SQLite Implementation ───────────────────────────────────

export class SqliteWorkerRepository implements WorkerRepository {
  private readonly db: ReturnType<typeof BetterSqlite3>;

  constructor(dbPath = process.env.WORKER_DB_PATH || '.local/worker.db') {
    if (dbPath === ':memory:') {
      this.db = new BetterSqlite3(':memory:');
    } else {
      const fullPath = path.resolve(dbPath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      this.db = new BetterSqlite3(fullPath);
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
    try {
      this.db.exec(`ALTER TABLE worker_tasks ADD COLUMN user_id TEXT`);
    } catch {
      /* column already exists */
    }
    try {
      this.db.exec(`ALTER TABLE worker_tasks ADD COLUMN flow_published_id TEXT`);
    } catch {
      /* column already exists */
    }
    try {
      this.db.exec(`ALTER TABLE worker_tasks ADD COLUMN current_run_id TEXT`);
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

    // Phase 2: assigned_persona_id on tasks
    try {
      this.db.exec(`ALTER TABLE worker_tasks ADD COLUMN assigned_persona_id TEXT`);
    } catch {
      /* column already exists */
    }

    // Phase 3: planning message storage
    try {
      this.db.exec(`ALTER TABLE worker_tasks ADD COLUMN planning_messages TEXT`);
    } catch {
      /* column already exists */
    }
    try {
      this.db.exec(`ALTER TABLE worker_tasks ADD COLUMN planning_complete INTEGER DEFAULT 0`);
    } catch {
      /* column already exists */
    }

    // Phase 2: activity log table
    this.db.exec(`
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

    // Orchestra V1: flow templates, drafts, published snapshots, runs, run nodes.
    this.db.exec(`
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

    this.db.exec(`
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

    this.db.exec(`
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

    this.db.exec(`
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

    this.db.exec(`
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

    this.db.exec(`
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

    this.db.exec(`
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

  private shouldIncludeLegacyRows(userId: string): boolean {
    return userId === LEGACY_LOCAL_USER_ID;
  }

  private toFlowDraft(row: Record<string, unknown>): WorkerFlowDraftRecord {
    return {
      id: row.id as string,
      templateId: (row.template_id as string) || null,
      userId: row.user_id as string,
      workspaceType: row.workspace_type as WorkerFlowDraftRecord['workspaceType'],
      name: row.name as string,
      graphJson: row.graph_json as string,
      status: row.status as WorkerFlowDraftRecord['status'],
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }

  private toFlowPublished(row: Record<string, unknown>): WorkerFlowPublishedRecord {
    return {
      id: row.id as string,
      draftId: (row.draft_id as string) || null,
      templateId: (row.template_id as string) || null,
      userId: row.user_id as string,
      workspaceType: row.workspace_type as WorkerFlowPublishedRecord['workspaceType'],
      name: row.name as string,
      graphJson: row.graph_json as string,
      version: Number(row.version || 1),
      createdAt: row.created_at as string,
    };
  }

  private toRun(row: Record<string, unknown>): WorkerRunRecord {
    return {
      id: row.id as string,
      taskId: row.task_id as string,
      userId: row.user_id as string,
      flowPublishedId: row.flow_published_id as string,
      status: row.status as WorkerRunRecord['status'],
      errorMessage: (row.error_message as string) || null,
      createdAt: row.created_at as string,
      startedAt: (row.started_at as string) || null,
      completedAt: (row.completed_at as string) || null,
    };
  }

  private toSubagentSession(row: Record<string, unknown>): WorkerSubagentSessionRecord {
    return {
      id: row.id as string,
      taskId: row.task_id as string,
      runId: (row.run_id as string) || null,
      nodeId: (row.node_id as string) || null,
      userId: row.user_id as string,
      personaId: (row.persona_id as string) || null,
      status: row.status as WorkerSubagentSessionRecord['status'],
      sessionRef: (row.session_ref as string) || null,
      metadata: (row.metadata as string) || null,
      startedAt: row.started_at as string,
      completedAt: (row.completed_at as string) || null,
    };
  }

  private toDeliverable(row: Record<string, unknown>): WorkerTaskDeliverableRecord {
    return {
      id: row.id as string,
      taskId: row.task_id as string,
      runId: (row.run_id as string) || null,
      nodeId: (row.node_id as string) || null,
      type: row.type as WorkerTaskDeliverableRecord['type'],
      name: row.name as string,
      content: row.content as string,
      mimeType: (row.mime_type as string) || null,
      metadata: (row.metadata as string) || null,
      createdAt: row.created_at as string,
    };
  }

  private toRunNode(row: Record<string, unknown>): WorkerRunNodeRecord {
    return {
      id: row.id as string,
      runId: row.run_id as string,
      nodeId: row.node_id as string,
      personaId: (row.persona_id as string) || null,
      status: row.status as WorkerRunNodeRecord['status'],
      outputSummary: (row.output_summary as string) || null,
      errorMessage: (row.error_message as string) || null,
      metadata: (row.metadata as string) || null,
      startedAt: (row.started_at as string) || null,
      completedAt: (row.completed_at as string) || null,
    };
  }

  // ─── Tasks ──────────────────────────────────────────────────

  createTask(input: CreateTaskInput): WorkerTaskRecord {
    const id = `task-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();

    const initialStatus = input.usePlanning ? 'inbox' : 'queued';

    this.db
      .prepare(
        `
      INSERT INTO worker_tasks (id, title, objective, status, priority,
        origin_platform, origin_conversation, origin_external_chat,
        workspace_type, user_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        id,
        input.title,
        input.objective,
        initialStatus,
        input.priority || 'normal',
        input.originPlatform,
        input.originConversation,
        input.originExternalChat || null,
        input.workspaceType || 'general',
        input.userId || null,
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

  getTaskForUser(id: string, userId: string): WorkerTaskRecord | null {
    const includeLegacy = this.shouldIncludeLegacyRows(userId);
    const row = (
      includeLegacy
        ? this.db
            .prepare('SELECT * FROM worker_tasks WHERE id = ? AND (user_id = ? OR user_id IS NULL)')
            .get(id, userId)
        : this.db.prepare('SELECT * FROM worker_tasks WHERE id = ? AND user_id = ?').get(id, userId)
    ) as Record<string, unknown> | undefined;
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

  listTasksForUser(
    userId: string,
    filter?: { status?: WorkerTaskStatus; limit?: number },
  ): WorkerTaskRecord[] {
    let sql = 'SELECT * FROM worker_tasks WHERE (user_id = ?';
    const params: SQLParam[] = [userId];

    if (this.shouldIncludeLegacyRows(userId)) {
      sql += ' OR user_id IS NULL';
    }
    sql += ')';

    if (filter?.status) {
      sql += ' AND status = ?';
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
    this.db.prepare(`DELETE FROM worker_task_deliverables WHERE task_id = ?`).run(id);
    this.db.prepare(`DELETE FROM worker_subagent_sessions WHERE task_id = ?`).run(id);
    this.db
      .prepare(
        `DELETE FROM worker_run_nodes WHERE run_id IN (SELECT id FROM worker_runs WHERE task_id = ?)`,
      )
      .run(id);
    this.db.prepare(`DELETE FROM worker_runs WHERE task_id = ?`).run(id);
    this.db.prepare(`DELETE FROM worker_task_activities WHERE task_id = ?`).run(id);
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

  setTaskRunContext(
    id: string,
    updates: { flowPublishedId?: string | null; currentRunId?: string | null },
  ): void {
    const clauses: string[] = [];
    const values: SQLParam[] = [];
    if (updates.flowPublishedId !== undefined) {
      clauses.push('flow_published_id = ?');
      values.push(updates.flowPublishedId);
    }
    if (updates.currentRunId !== undefined) {
      clauses.push('current_run_id = ?');
      values.push(updates.currentRunId);
    }
    if (clauses.length === 0) return;
    values.push(id);
    this.db.prepare(`UPDATE worker_tasks SET ${clauses.join(', ')} WHERE id = ?`).run(...values);
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

  updateObjective(id: string, objective: string): void {
    this.db.prepare(`UPDATE worker_tasks SET objective = ? WHERE id = ?`).run(objective, id);
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

  // ─── Persona Assignment ─────────────────────────────────────

  assignPersona(taskId: string, personaId: string | null): void {
    this.db
      .prepare(`UPDATE worker_tasks SET assigned_persona_id = ? WHERE id = ?`)
      .run(personaId, taskId);
  }

  // ─── Planning ───────────────────────────────────────────────

  getPlanningMessages(taskId: string): import('./workerTypes').PlanningMessage[] {
    const row = this.db
      .prepare('SELECT planning_messages FROM worker_tasks WHERE id = ?')
      .get(taskId) as Record<string, unknown> | undefined;
    if (!row || !row.planning_messages) return [];
    try {
      return JSON.parse(row.planning_messages as string);
    } catch {
      return [];
    }
  }

  savePlanningMessages(taskId: string, messages: import('./workerTypes').PlanningMessage[]): void {
    this.db
      .prepare('UPDATE worker_tasks SET planning_messages = ? WHERE id = ?')
      .run(JSON.stringify(messages), taskId);
  }

  completePlanning(taskId: string): void {
    this.db.prepare('UPDATE worker_tasks SET planning_complete = 1 WHERE id = ?').run(taskId);
  }

  // ─── Activities ─────────────────────────────────────────────

  addActivity(input: SaveActivityInput): TaskActivityRecord {
    const id = `act-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const metadata = input.metadata ? JSON.stringify(input.metadata) : null;

    this.db
      .prepare(
        `INSERT INTO worker_task_activities (id, task_id, type, message, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.taskId, input.type, input.message, metadata, now);

    const row = this.db
      .prepare('SELECT * FROM worker_task_activities WHERE id = ?')
      .get(id) as Record<string, unknown>;
    return toActivity(row);
  }

  getActivities(taskId: string, limit = 50): TaskActivityRecord[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM worker_task_activities WHERE task_id = ? ORDER BY created_at DESC LIMIT ?',
      )
      .all(taskId, limit) as Array<Record<string, unknown>>;
    return rows.map(toActivity);
  }

  // ─── Subagent Sessions ─────────────────────────────────────

  createSubagentSession(input: {
    taskId: string;
    userId: string;
    runId?: string | null;
    nodeId?: string | null;
    personaId?: string | null;
    sessionRef?: string | null;
    metadata?: Record<string, unknown>;
  }): WorkerSubagentSessionRecord {
    const id = `subagent-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const metadata = input.metadata ? JSON.stringify(input.metadata) : null;
    const runId =
      input.runId && this.db.prepare('SELECT 1 FROM worker_runs WHERE id = ?').get(input.runId)
        ? input.runId
        : null;

    this.db
      .prepare(
        `INSERT INTO worker_subagent_sessions
         (id, task_id, run_id, node_id, user_id, persona_id, status, session_ref, metadata, started_at)
         VALUES (?, ?, ?, ?, ?, ?, 'started', ?, ?, ?)`,
      )
      .run(
        id,
        input.taskId,
        runId,
        input.nodeId || null,
        input.userId,
        input.personaId || null,
        input.sessionRef || null,
        metadata,
        now,
      );

    const row = this.db
      .prepare('SELECT * FROM worker_subagent_sessions WHERE id = ?')
      .get(id) as Record<string, unknown>;
    return this.toSubagentSession(row);
  }

  updateSubagentSession(
    taskId: string,
    sessionId: string,
    updates: { status?: WorkerSubagentSessionRecord['status']; metadata?: Record<string, unknown> },
  ): WorkerSubagentSessionRecord | null {
    const existing = this.db
      .prepare('SELECT * FROM worker_subagent_sessions WHERE id = ? AND task_id = ?')
      .get(sessionId, taskId) as Record<string, unknown> | undefined;
    if (!existing) return null;

    const clauses: string[] = [];
    const values: SQLParam[] = [];
    if (updates.status) {
      clauses.push('status = ?');
      values.push(updates.status);
      if (
        updates.status === 'completed' ||
        updates.status === 'failed' ||
        updates.status === 'cancelled'
      ) {
        clauses.push('completed_at = ?');
        values.push(new Date().toISOString());
      }
    }
    if (updates.metadata) {
      clauses.push('metadata = ?');
      values.push(JSON.stringify(updates.metadata));
    }
    if (clauses.length > 0) {
      values.push(sessionId, taskId);
      this.db
        .prepare(
          `UPDATE worker_subagent_sessions SET ${clauses.join(', ')} WHERE id = ? AND task_id = ?`,
        )
        .run(...values);
    }

    const row = this.db
      .prepare('SELECT * FROM worker_subagent_sessions WHERE id = ? AND task_id = ?')
      .get(sessionId, taskId) as Record<string, unknown> | undefined;
    return row ? this.toSubagentSession(row) : null;
  }

  listSubagentSessions(taskId: string, limit = 100): WorkerSubagentSessionRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM worker_subagent_sessions
         WHERE task_id = ?
         ORDER BY started_at DESC
         LIMIT ?`,
      )
      .all(taskId, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => this.toSubagentSession(row));
  }

  // ─── Deliverables ──────────────────────────────────────────

  addDeliverable(input: {
    taskId: string;
    runId?: string | null;
    nodeId?: string | null;
    type: WorkerTaskDeliverableRecord['type'];
    name: string;
    content: string;
    mimeType?: string | null;
    metadata?: Record<string, unknown>;
  }): WorkerTaskDeliverableRecord {
    const id = `del-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const metadata = input.metadata ? JSON.stringify(input.metadata) : null;

    this.db
      .prepare(
        `INSERT INTO worker_task_deliverables
         (id, task_id, run_id, node_id, type, name, content, mime_type, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.taskId,
        input.runId || null,
        input.nodeId || null,
        input.type,
        input.name,
        input.content,
        input.mimeType || null,
        metadata,
        now,
      );

    const row = this.db
      .prepare('SELECT * FROM worker_task_deliverables WHERE id = ?')
      .get(id) as Record<string, unknown>;
    return this.toDeliverable(row);
  }

  listDeliverables(taskId: string): WorkerTaskDeliverableRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM worker_task_deliverables
         WHERE task_id = ?
         ORDER BY created_at ASC`,
      )
      .all(taskId) as Array<Record<string, unknown>>;
    return rows.map((row) => this.toDeliverable(row));
  }

  // ─── Orchestra Flows ───────────────────────────────────────

  listFlowDrafts(userId: string, workspaceType?: WorkerFlowDraftRecord['workspaceType']) {
    let sql = 'SELECT * FROM worker_flow_drafts WHERE user_id = ?';
    const params: SQLParam[] = [userId];
    if (workspaceType) {
      sql += ' AND workspace_type = ?';
      params.push(workspaceType);
    }
    sql += ' ORDER BY updated_at DESC';

    const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    return rows.map((row) => this.toFlowDraft(row));
  }

  getFlowDraft(id: string, userId: string): WorkerFlowDraftRecord | null {
    const row = this.db
      .prepare('SELECT * FROM worker_flow_drafts WHERE id = ? AND user_id = ?')
      .get(id, userId) as Record<string, unknown> | undefined;
    return row ? this.toFlowDraft(row) : null;
  }

  createFlowDraft(input: {
    userId: string;
    workspaceType: WorkerFlowDraftRecord['workspaceType'];
    name: string;
    graphJson: string;
    templateId?: string | null;
  }): WorkerFlowDraftRecord {
    const id = `flow-draft-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO worker_flow_drafts
         (id, template_id, user_id, workspace_type, name, graph_json, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
      )
      .run(
        id,
        input.templateId || null,
        input.userId,
        input.workspaceType,
        input.name,
        input.graphJson,
        now,
        now,
      );

    return this.getFlowDraft(id, input.userId)!;
  }

  updateFlowDraft(
    id: string,
    userId: string,
    updates: {
      name?: string;
      graphJson?: string;
      workspaceType?: WorkerFlowDraftRecord['workspaceType'];
    },
  ): WorkerFlowDraftRecord | null {
    const existing = this.getFlowDraft(id, userId);
    if (!existing) return null;

    const now = new Date().toISOString();
    const nextName = updates.name ?? existing.name;
    const nextGraphJson = updates.graphJson ?? existing.graphJson;
    const nextWorkspaceType = updates.workspaceType ?? existing.workspaceType;

    this.db
      .prepare(
        `UPDATE worker_flow_drafts
         SET name = ?, graph_json = ?, workspace_type = ?, updated_at = ?
         WHERE id = ? AND user_id = ?`,
      )
      .run(nextName, nextGraphJson, nextWorkspaceType, now, id, userId);

    return this.getFlowDraft(id, userId);
  }

  publishFlowDraft(id: string, userId: string): WorkerFlowPublishedRecord | null {
    const draft = this.getFlowDraft(id, userId);
    if (!draft) return null;

    const versionRow = this.db
      .prepare(
        `SELECT COALESCE(MAX(version), 0) + 1 AS next_version
         FROM worker_flow_published
         WHERE user_id = ? AND name = ?`,
      )
      .get(userId, draft.name) as { next_version: number };

    const publishedId = `flow-pub-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO worker_flow_published
         (id, draft_id, template_id, user_id, workspace_type, name, graph_json, version, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        publishedId,
        draft.id,
        draft.templateId,
        userId,
        draft.workspaceType,
        draft.name,
        draft.graphJson,
        Number(versionRow.next_version || 1),
        now,
      );

    return this.getFlowPublished(publishedId, userId);
  }

  getFlowPublished(id: string, userId: string): WorkerFlowPublishedRecord | null {
    const row = this.db
      .prepare('SELECT * FROM worker_flow_published WHERE id = ? AND user_id = ?')
      .get(id, userId) as Record<string, unknown> | undefined;
    return row ? this.toFlowPublished(row) : null;
  }

  listPublishedFlows(
    userId: string,
    workspaceType?: WorkerFlowPublishedRecord['workspaceType'],
  ): WorkerFlowPublishedRecord[] {
    let sql = 'SELECT * FROM worker_flow_published WHERE user_id = ?';
    const params: SQLParam[] = [userId];
    if (workspaceType) {
      sql += ' AND workspace_type = ?';
      params.push(workspaceType);
    }
    sql += ' ORDER BY created_at DESC';

    const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    return rows.map((row) => this.toFlowPublished(row));
  }

  createRun(input: {
    taskId: string;
    userId: string;
    flowPublishedId: string;
    status?: WorkerRunRecord['status'];
  }): WorkerRunRecord {
    const id = `run-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const status = input.status ?? 'pending';
    this.db
      .prepare(
        `INSERT INTO worker_runs
         (id, task_id, user_id, flow_published_id, status, created_at, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.taskId, input.userId, input.flowPublishedId, status, now, now);

    const row = this.db.prepare('SELECT * FROM worker_runs WHERE id = ?').get(id) as Record<
      string,
      unknown
    >;
    return this.toRun(row);
  }

  updateRunStatus(
    runId: string,
    updates: { status: WorkerRunRecord['status']; errorMessage?: string | null },
  ): WorkerRunRecord | null {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE worker_runs
         SET status = ?,
             error_message = COALESCE(?, error_message),
             completed_at = CASE WHEN ? IN ('completed', 'failed', 'cancelled') THEN ? ELSE completed_at END
         WHERE id = ?`,
      )
      .run(updates.status, updates.errorMessage || null, updates.status, now, runId);
    if (result.changes === 0) return null;

    const row = this.db.prepare('SELECT * FROM worker_runs WHERE id = ?').get(runId) as Record<
      string,
      unknown
    > | null;
    return row ? this.toRun(row) : null;
  }

  upsertRunNodeStatus(
    runId: string,
    nodeId: string,
    updates: {
      personaId?: string | null;
      status: WorkerRunNodeRecord['status'];
      errorMessage?: string | null;
      outputSummary?: string | null;
    },
  ): WorkerRunNodeRecord {
    const existing = this.db
      .prepare('SELECT * FROM worker_run_nodes WHERE run_id = ? AND node_id = ?')
      .get(runId, nodeId) as Record<string, unknown> | undefined;

    const now = new Date().toISOString();
    if (!existing) {
      const id = `run-node-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
      this.db
        .prepare(
          `INSERT INTO worker_run_nodes
           (id, run_id, node_id, persona_id, status, output_summary, error_message, started_at, completed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          runId,
          nodeId,
          updates.personaId || null,
          updates.status,
          updates.outputSummary || null,
          updates.errorMessage || null,
          updates.status === 'running' ? now : null,
          updates.status === 'completed' ||
            updates.status === 'failed' ||
            updates.status === 'skipped'
            ? now
            : null,
        );
    } else {
      this.db
        .prepare(
          `UPDATE worker_run_nodes
           SET persona_id = COALESCE(?, persona_id),
               status = ?,
               output_summary = COALESCE(?, output_summary),
               error_message = COALESCE(?, error_message),
               started_at = CASE WHEN ? = 'running' THEN COALESCE(started_at, ?) ELSE started_at END,
               completed_at = CASE WHEN ? IN ('completed', 'failed', 'skipped') THEN ? ELSE completed_at END
           WHERE run_id = ? AND node_id = ?`,
        )
        .run(
          updates.personaId || null,
          updates.status,
          updates.outputSummary || null,
          updates.errorMessage || null,
          updates.status,
          now,
          updates.status,
          now,
          runId,
          nodeId,
        );
    }

    const row = this.db
      .prepare('SELECT * FROM worker_run_nodes WHERE run_id = ? AND node_id = ?')
      .get(runId, nodeId) as Record<string, unknown>;
    return this.toRunNode(row);
  }

  listRunNodes(runId: string): WorkerRunNodeRecord[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM worker_run_nodes WHERE run_id = ? ORDER BY started_at ASC, node_id ASC',
      )
      .all(runId) as Array<Record<string, unknown>>;
    return rows.map((row) => this.toRunNode(row));
  }

  getOrchestraMetrics(): {
    runCount: number;
    failFastAbortCount: number;
    activeSubagentSessions: number;
  } {
    const runCountRow = this.db.prepare('SELECT COUNT(*) AS count FROM worker_runs').get() as {
      count: number;
    };
    const failedRunsRow = this.db
      .prepare("SELECT COUNT(*) AS count FROM worker_runs WHERE status = 'failed'")
      .get() as { count: number };
    const activeSubagentsRow = this.db
      .prepare(
        "SELECT COUNT(*) AS count FROM worker_subagent_sessions WHERE status IN ('started', 'running')",
      )
      .get() as { count: number };

    return {
      runCount: Number(runCountRow.count || 0),
      failFastAbortCount: Number(failedRunsRow.count || 0),
      activeSubagentSessions: Number(activeSubagentsRow.count || 0),
    };
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
