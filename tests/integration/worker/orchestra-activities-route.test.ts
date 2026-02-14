import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

function mockUserContext(context: { userId: string; authenticated: boolean } | null): void {
  vi.doMock('../../../src/server/auth/userContext', () => ({
    resolveRequestUserContext: vi.fn().mockResolvedValue(context),
  }));
}

async function loadActivitiesRoute() {
  return import('../../../app/api/worker/[id]/activities/route');
}

async function loadWorkerRepository() {
  return import('../../../src/server/worker/workerRepository');
}

describe('orchestra activities route', () => {
  const cleanupPaths: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    delete process.env.WORKER_DB_PATH;

    for (const filePath of cleanupPaths.splice(0, cleanupPaths.length)) {
      for (const candidate of [filePath, `${filePath}-wal`, `${filePath}-shm`]) {
        try {
          if (fs.existsSync(candidate)) {
            fs.unlinkSync(candidate);
          }
        } catch {
          // ignore file lock in tests
        }
      }
    }
  });

  it('returns activities in requested order', async () => {
    const dbPath = path.join(
      process.cwd(),
      '.local',
      `worker.orchestra.activities.${Date.now()}.${Math.random().toString(36).slice(2)}.db`,
    );
    cleanupPaths.push(dbPath);
    process.env.WORKER_DB_PATH = dbPath;
    mockUserContext({ userId: 'user-a', authenticated: true });

    const { getWorkerRepository } = await loadWorkerRepository();
    const repo = getWorkerRepository();
    const task = repo.createTask({
      title: 'Activities test task',
      objective: 'Exercise activities route',
      originPlatform: 'WebChat' as never,
      originConversation: 'conv-user-a',
      userId: 'user-a',
    });
    repo.addActivity({ taskId: task.id, type: 'note', message: 'first message' });
    repo.addActivity({ taskId: task.id, type: 'note', message: 'second message' });

    const route = await loadActivitiesRoute();
    const ascResponse = await route.GET(
      new Request(`http://localhost/api/worker/${task.id}/activities?order=asc`),
      { params: Promise.resolve({ id: task.id }) },
    );
    const ascPayload = (await ascResponse.json()) as {
      ok: boolean;
      activities: Array<{ message: string }>;
    };

    expect(ascResponse.status).toBe(200);
    expect(ascPayload.ok).toBe(true);
    expect(ascPayload.activities[0].message).toBe('first message');
    expect(ascPayload.activities[1].message).toBe('second message');
  });
});
