import fs from 'node:fs';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getWorkerRepository } from '../../src/server/worker/workerRepository';
import { getWorkspaceManager } from '../../src/server/worker/workspaceManager';
import { DELETE as deleteAllTasksRoute } from '../../app/api/worker/route';
import { DELETE as deleteTaskRoute } from '../../app/api/worker/[id]/route';

const workerDbPath = path.join(
  process.cwd(),
  '.local',
  `worker.delete.routes.${Date.now()}.${Math.random().toString(36).slice(2)}.db`,
);

describe('worker delete routes', () => {
  let repo: ReturnType<typeof getWorkerRepository>;
  let ws: ReturnType<typeof getWorkspaceManager>;
  const createdWorkspaceIds: string[] = [];

  beforeAll(() => {
    process.env.WORKER_DB_PATH = workerDbPath;
    repo = getWorkerRepository();
    ws = getWorkspaceManager();
  });

  afterAll(() => {
    for (const taskId of createdWorkspaceIds) {
      const wsPath = path.join(process.cwd(), 'workspaces', taskId);
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      if (fs.existsSync(wsPath)) {
        try {
          fs.rmSync(wsPath, { recursive: true, force: true });
        } catch {
          // ignore transient lock
        }
      }
    }

    for (const candidate of [workerDbPath, `${workerDbPath}-wal`, `${workerDbPath}-shm`]) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      if (fs.existsSync(candidate)) {
        try {
          // eslint-disable-next-line security/detect-non-literal-fs-filename
          fs.unlinkSync(candidate);
        } catch {
          // ignore transient lock
        }
      }
    }
  });

  it('DELETE /api/worker/:id removes task, steps, artifacts and workspace', async () => {
    const task = repo.createTask({
      title: 'Delete me',
      objective: 'Delete test',
      workspaceType: 'general',
      priority: 'normal',
      originPlatform: 'WebChat' as never,
      originConversation: `conv-${Date.now()}`,
    });
    createdWorkspaceIds.push(task.id);

    ws.createWorkspace(task.id, 'general');
    ws.writeFile(task.id, 'output/file.txt', 'delete me');
    repo.saveSteps(task.id, [{ taskId: task.id, stepIndex: 0, description: 'step' }]);
    repo.saveArtifact({
      taskId: task.id,
      name: 'artifact.txt',
      type: 'doc',
      content: 'artifact',
    });

    const response = await deleteTaskRoute(
      new Request(`http://localhost/api/worker/${task.id}`, { method: 'DELETE' }),
      { params: Promise.resolve({ id: task.id }) },
    );
    const payload = (await response.json()) as { ok: boolean };

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(repo.getTask(task.id)).toBeNull();
    expect(repo.getSteps(task.id)).toHaveLength(0);
    expect(repo.getArtifacts(task.id)).toHaveLength(0);
    expect(ws.exists(task.id)).toBe(false);
  });

  it('DELETE /api/worker removes all tasks, even when more than 1000 exist', async () => {
    const baseCount = repo.listTasks({ limit: 5000 }).length;

    for (let i = 0; i < 1001; i++) {
      repo.createTask({
        title: `Task ${i}`,
        objective: 'Bulk delete test',
        workspaceType: 'general',
        priority: 'normal',
        originPlatform: 'WebChat' as never,
        originConversation: `bulk-${Date.now()}`,
      });
    }

    expect(repo.listTasks({ limit: 5000 }).length).toBe(baseCount + 1001);

    const response = await deleteAllTasksRoute();
    const payload = (await response.json()) as { ok: boolean; deleted: number };

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.deleted).toBe(baseCount + 1001);
    expect(repo.listTasks({ limit: 5000 })).toHaveLength(0);
  }, 20_000);
});
