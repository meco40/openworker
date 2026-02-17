import crypto from 'node:crypto';
import { toFlowDraft, toFlowPublished, toRun, toRunNode } from '../workerRowMappers';
import type {
  WorkerFlowDraftRecord,
  WorkerFlowPublishedRecord,
  WorkerRunRecord,
  WorkerRunNodeRecord,
} from '../orchestraTypes';
import type { WorkspaceType } from '../workerTypes';
import { BaseRepository, SQLParam } from './baseRepository';

/**
 * Repository for flow-related operations (drafts, published flows, runs, run nodes).
 */
export class FlowRepository extends BaseRepository {
  // ─── Flow Drafts ────────────────────────────────────────────

  listFlowDrafts(userId: string, workspaceType?: WorkspaceType) {
    let sql = 'SELECT * FROM worker_flow_drafts WHERE user_id = ?';
    const params: SQLParam[] = [userId];
    if (workspaceType) {
      sql += ' AND workspace_type = ?';
      params.push(workspaceType);
    }
    sql += ' ORDER BY updated_at DESC';

    const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    return rows.map((row) => toFlowDraft(row));
  }

  getFlowDraft(id: string, userId: string): WorkerFlowDraftRecord | null {
    const row = this.db
      .prepare('SELECT * FROM worker_flow_drafts WHERE id = ? AND user_id = ?')
      .get(id, userId) as Record<string, unknown> | undefined;
    return row ? toFlowDraft(row) : null;
  }

  createFlowDraft(input: {
    userId: string;
    workspaceType: WorkspaceType;
    name: string;
    graphJson: string;
    templateId?: string | null;
  }): WorkerFlowDraftRecord {
    const id = `flow-draft-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const now = this.now();
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
      workspaceType?: WorkspaceType;
    },
    expectedUpdatedAt?: string,
  ): WorkerFlowDraftRecord | null {
    const existing = this.getFlowDraft(id, userId);
    if (!existing) return null;

    // Optimistic locking: reject stale writes
    if (expectedUpdatedAt && existing.updatedAt !== expectedUpdatedAt) {
      return null;
    }

    // Prevent editing published drafts
    if (existing.status === 'published') {
      return null;
    }

    const now = this.now();
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
    const now = this.now();
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

    // Mark draft as published
    this.db
      .prepare(`UPDATE worker_flow_drafts SET status = 'published' WHERE id = ? AND user_id = ?`)
      .run(draft.id, userId);

    return this.getFlowPublished(publishedId, userId);
  }

  deleteFlowDraft(id: string, userId: string): boolean {
    const result = this.db
      .prepare('DELETE FROM worker_flow_drafts WHERE id = ? AND user_id = ?')
      .run(id, userId);
    return (result.changes ?? 0) > 0;
  }

  // ─── Published Flows ───────────────────────────────────────

  deletePublishedFlow(id: string, userId: string): boolean {
    // Prevent deletion if any task references this published flow
    const taskRef = this.db
      .prepare('SELECT id FROM worker_tasks WHERE flow_published_id = ? LIMIT 1')
      .get(id) as Record<string, unknown> | undefined;
    if (taskRef) return false;

    const result = this.db
      .prepare('DELETE FROM worker_flow_published WHERE id = ? AND user_id = ?')
      .run(id, userId);
    return (result.changes ?? 0) > 0;
  }

  getFlowPublished(id: string, userId: string): WorkerFlowPublishedRecord | null {
    const row = this.db
      .prepare('SELECT * FROM worker_flow_published WHERE id = ? AND user_id = ?')
      .get(id, userId) as Record<string, unknown> | undefined;
    return row ? toFlowPublished(row) : null;
  }

  listPublishedFlows(userId: string, workspaceType?: WorkspaceType): WorkerFlowPublishedRecord[] {
    let sql = 'SELECT * FROM worker_flow_published WHERE user_id = ?';
    const params: SQLParam[] = [userId];
    if (workspaceType) {
      sql += ' AND workspace_type = ?';
      params.push(workspaceType);
    }
    sql += ' ORDER BY created_at DESC';

    const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    return rows.map((row) => toFlowPublished(row));
  }

  // ─── Runs ──────────────────────────────────────────────────

  createRun(input: {
    taskId: string;
    userId: string;
    flowPublishedId: string;
    status?: WorkerRunRecord['status'];
  }): WorkerRunRecord {
    const id = `run-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const now = this.now();
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
    return toRun(row);
  }

  updateRunStatus(
    runId: string,
    updates: { status: WorkerRunRecord['status']; errorMessage?: string | null },
  ): WorkerRunRecord | null {
    const now = this.now();
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
    return row ? toRun(row) : null;
  }

  // ─── Run Nodes ─────────────────────────────────────────────

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

    const now = this.now();
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
    return toRunNode(row);
  }

  listRunNodes(runId: string): WorkerRunNodeRecord[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM worker_run_nodes WHERE run_id = ? ORDER BY started_at ASC, node_id ASC',
      )
      .all(runId) as Array<Record<string, unknown>>;
    return rows.map((row) => toRunNode(row));
  }

  // ─── Metrics ───────────────────────────────────────────────

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
}
