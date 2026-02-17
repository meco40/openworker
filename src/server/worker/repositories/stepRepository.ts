import crypto from 'node:crypto';
import { toStep } from '../workerRowMappers';
import type {
  WorkerRepository,
  WorkerStepRecord,
  WorkerStepStatus,
  SaveStepInput,
} from '../workerTypes';
import { BaseRepository, SQLParam } from './baseRepository';

/**
 * Repository for step-related operations.
 */
export class StepRepository extends BaseRepository implements Pick<WorkerRepository,
  | 'saveSteps'
  | 'getSteps'
  | 'updateStepStatus'
> {
  
  saveSteps(taskId: string, steps: SaveStepInput[]): void {
    const stmt = this.db.prepare(`
      INSERT INTO worker_steps (id, task_id, step_index, description, status)
      VALUES (?, ?, ?, ?, 'pending')
    `);

    for (const step of steps) {
      const id = `step-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
      stmt.run(id, taskId, step.stepIndex, step.description);
    }

    // Update total steps count on the task
    this.db.prepare(`UPDATE worker_tasks SET total_steps = ? WHERE id = ?`).run(steps.length, taskId);
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
    const now = this.now();
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
}
