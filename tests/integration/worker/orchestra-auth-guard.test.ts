import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

function mockUserContext(context: { userId: string; authenticated: boolean } | null): void {
  vi.doMock('../../../src/server/auth/userContext', () => ({
    resolveRequestUserContext: vi.fn().mockResolvedValue(context),
  }));
}

async function loadWorkerRootRoute() {
  return import('../../../app/api/worker/route');
}

async function loadWorkerActivitiesRoute() {
  return import('../../../app/api/worker/[id]/activities/route');
}

async function loadOrchestraFlowsRoute() {
  return import('../../../app/api/worker/orchestra/flows/route');
}

describe('worker orchestra auth guard', () => {
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

  it('returns 401 for unauthenticated worker and orchestra endpoints', async () => {
    const dbPath = path.join(
      process.cwd(),
      '.local',
      `worker.orchestra.auth.${Date.now()}.${Math.random().toString(36).slice(2)}.db`,
    );
    cleanupPaths.push(dbPath);
    process.env.WORKER_DB_PATH = dbPath;

    mockUserContext(null);
    const workerRoot = await loadWorkerRootRoute();
    const flowsRoute = await loadOrchestraFlowsRoute();
    const activitiesRoute = await loadWorkerActivitiesRoute();

    const workerResponse = await workerRoot.GET(new Request('http://localhost/api/worker'));
    const flowsResponse = await flowsRoute.GET(
      new Request('http://localhost/api/worker/orchestra/flows'),
    );
    const activitiesResponse = await activitiesRoute.GET(
      new Request('http://localhost/api/worker/task-unknown/activities'),
      { params: Promise.resolve({ id: 'task-unknown' }) },
    );

    expect(workerResponse.status).toBe(401);
    expect(flowsResponse.status).toBe(401);
    expect(activitiesResponse.status).toBe(401);
  });
});
