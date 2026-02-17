import crypto from 'node:crypto';
import { toTask } from '../workerRowMappers';
import type {
  WorkerTaskRecord,
  WorkerTaskStatus,
  CreateTaskInput,
  PlanningMessage,
} from '../workerTypes';
import { BaseRepository, SQLParam } from './baseRepository';

/**
 * Repository for task-related operations.
 */
export class TaskRepository extends BaseRepository {
  createTask(input: CreateTaskInput): WorkerTaskRecord {
    const id = `task-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const now = this.now();
    const initialStatus = input.usePlanning ? 'inbox' : 'queued';

    this.db
      .prepare(
        `
        INSERT INTO worker_tasks (id, title, objective, status, priority,
          origin_platform, origin_conversation, origin_external_chat,
          workspace_type, user_id, flow_published_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        input.flowPublishedId || null,
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
    const now = this.now();
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
    // Delete related records in correct order to respect foreign keys
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

  assignPersona(taskId: string, personaId: string | null): void {
    this.db
      .prepare(`UPDATE worker_tasks SET assigned_persona_id = ? WHERE id = ?`)
      .run(personaId, taskId);
  }

  getPlanningMessages(taskId: string): PlanningMessage[] {
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

  savePlanningMessages(taskId: string, messages: PlanningMessage[]): void {
    this.db
      .prepare('UPDATE worker_tasks SET planning_messages = ? WHERE id = ?')
      .run(JSON.stringify(messages), taskId);
  }

  completePlanning(taskId: string): void {
    this.db.prepare('UPDATE worker_tasks SET planning_complete = 1 WHERE id = ?').run(taskId);
  }
}
