import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  closeWorldModelDb,
  getWorldModelDb,
  runWorldModelMigrations,
} from '@/server/world-model/db';
import {
  projectMissionControlTaskCreated,
  projectMissionControlTaskDeleted,
  projectMissionControlTaskStatusChanged,
} from '@/server/world-model/services/missionControlBridge';
import type { OutboxEvent } from '@/server/world-model/types';

const enabled = process.env.WORLD_MODEL_E2E === 'true';
const marker = `mission-control-task-${Date.now()}`;
const taskId = `mc-task-${Date.now()}`;

function event(eventType: string, payload: Record<string, unknown>): OutboxEvent {
  return {
    id: crypto.randomUUID(),
    eventType,
    aggregateType: 'task',
    aggregateId: taskId,
    payload,
    status: 'pending',
    attempts: 0,
    createdAt: new Date().toISOString(),
  };
}

describe.skipIf(!enabled)('Mission Control task projection', () => {
  beforeAll(async () => {
    await runWorldModelMigrations();
  });

  afterAll(async () => {
    const db = getWorldModelDb();
    await db.query(
      `DELETE FROM world_model_task_transitions
       WHERE task_id IN (SELECT id FROM world_model_tasks WHERE user_id = $1)`,
      [marker],
    );
    await db.query('DELETE FROM world_model_tasks WHERE user_id = $1', [marker]);
    await closeWorldModelDb();
  });

  it('projects create, status replay and deletion as an auditable lifecycle', async () => {
    const scope = {
      taskId,
      userId: marker,
      personaId: 'assistant',
      workspaceId: 'workspace-a',
    };

    await projectMissionControlTaskCreated(
      event('world.task.created', {
        ...scope,
        title: 'Prepare cinema dinner',
        status: 'inbox',
      }),
    );

    const db = getWorldModelDb();
    const created = await db.query<{
      status: string;
      requester: string;
      assignee: string;
      external_task_id: string;
    }>(
      `SELECT status, requester, assignee, external_task_id
       FROM world_model_tasks
       WHERE user_id = $1 AND external_task_id = $2`,
      [marker, taskId],
    );
    expect(created.rows[0]).toMatchObject({
      status: 'proposed',
      requester: marker,
      assignee: marker,
      external_task_id: taskId,
    });

    const statusEvent = event('world.task.status_changed', {
      ...scope,
      previousStatus: 'proposed',
      newStatus: 'planned',
    });
    await projectMissionControlTaskStatusChanged(statusEvent);
    await projectMissionControlTaskStatusChanged(statusEvent);

    await projectMissionControlTaskDeleted(
      event('world.task.deleted', {
        ...scope,
      }),
    );

    const result = await db.query<{ status: string; transitions: string }>(
      `SELECT task.status,
              (SELECT count(*) FROM world_model_task_transitions transition
               WHERE transition.task_id = task.id) AS transitions
       FROM world_model_tasks task
       WHERE task.user_id = $1 AND task.external_task_id = $2`,
      [marker, taskId],
    );
    expect(result.rows[0]).toEqual({ status: 'cancelled', transitions: '2' });
  });
});
