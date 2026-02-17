import crypto from 'node:crypto';
import { toActivity } from '../workerRowMappers';
import type {
  TaskActivityRecord,
  SaveActivityInput,
} from '../workerTypes';
import { BaseRepository } from './baseRepository';

/**
 * Repository for activity-related operations.
 */
export class ActivityRepository extends BaseRepository {
  
  addActivity(input: SaveActivityInput): TaskActivityRecord {
    const id = `act-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const now = this.now();
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
}
