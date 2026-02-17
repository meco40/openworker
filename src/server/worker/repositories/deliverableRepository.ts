import crypto from 'node:crypto';
import { toDeliverable } from '../workerRowMappers';
import type {
  WorkerTaskDeliverableRecord,
} from '../orchestraTypes';
import { BaseRepository } from './baseRepository';

/**
 * Repository for deliverable-related operations.
 */
export class DeliverableRepository extends BaseRepository {
  
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
    const now = this.now();
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
    return toDeliverable(row);
  }

  listDeliverables(taskId: string): WorkerTaskDeliverableRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM worker_task_deliverables
         WHERE task_id = ?
         ORDER BY created_at ASC`,
      )
      .all(taskId) as Array<Record<string, unknown>>;
    return rows.map((row) => toDeliverable(row));
  }
}
