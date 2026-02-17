import crypto from 'node:crypto';
import { toSubagentSession } from '../workerRowMappers';
import type {
  WorkerSubagentSessionRecord,
} from '../orchestraTypes';
import { BaseRepository, SQLParam } from './baseRepository';

/**
 * Repository for subagent session-related operations.
 */
export class SubagentRepository extends BaseRepository {
  
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
    const now = this.now();
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
    return toSubagentSession(row);
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
        values.push(this.now());
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
    return row ? toSubagentSession(row) : null;
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
    return rows.map((row) => toSubagentSession(row));
  }

  listActiveSubagentSessions(taskId: string): WorkerSubagentSessionRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM worker_subagent_sessions
         WHERE task_id = ?
           AND status IN ('started', 'running')
         ORDER BY started_at DESC`,
      )
      .all(taskId) as Array<Record<string, unknown>>;
    return rows.map((row) => toSubagentSession(row));
  }
}
