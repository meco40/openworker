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

async function loadWorkerTaskRoute() {
  return import('../../../app/api/worker/[id]/route');
}

async function loadOrchestraFlowsRoute() {
  return import('../../../app/api/worker/orchestra/flows/route');
}

async function loadOrchestraFlowByIdRoute() {
  return import('../../../app/api/worker/orchestra/flows/[id]/route');
}

describe('worker orchestra user scope', () => {
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

  it('prevents cross-user task and flow access', async () => {
    const dbPath = path.join(
      process.cwd(),
      '.local',
      `worker.orchestra.scope.${Date.now()}.${Math.random().toString(36).slice(2)}.db`,
    );
    cleanupPaths.push(dbPath);
    process.env.WORKER_DB_PATH = dbPath;

    mockUserContext({ userId: 'user-a', authenticated: true });
    const workerRouteA = await loadWorkerRootRoute();
    const createTaskResponse = await workerRouteA.POST(
      new Request('http://localhost/api/worker', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          objective: 'Task only for user-a',
          conversationId: 'conv-user-a',
          usePlanning: true,
        }),
      }),
    );
    const createdTaskPayload = (await createTaskResponse.json()) as {
      ok: boolean;
      task: { id: string };
    };
    expect(createTaskResponse.status).toBe(200);
    expect(createdTaskPayload.ok).toBe(true);

    const flowsRouteA = await loadOrchestraFlowsRoute();
    const createFlowResponse = await flowsRouteA.POST(
      new Request('http://localhost/api/worker/orchestra/flows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'User A Flow',
          workspaceType: 'research',
          graph: {
            nodes: [{ id: 'n1', type: 'task', personaId: 'persona-a', position: { x: 0, y: 0 } }],
            edges: [],
          },
        }),
      }),
    );
    const createFlowPayload = (await createFlowResponse.json()) as {
      ok: boolean;
      flow: { id: string };
    };
    expect(createFlowResponse.status).toBe(201);
    expect(createFlowPayload.ok).toBe(true);

    vi.resetModules();
    mockUserContext({ userId: 'user-b', authenticated: true });
    const workerTaskRouteB = await loadWorkerTaskRoute();
    const flowByIdRouteB = await loadOrchestraFlowByIdRoute();

    const crossTaskResponse = await workerTaskRouteB.GET(
      new Request(`http://localhost/api/worker/${createdTaskPayload.task.id}`),
      { params: Promise.resolve({ id: createdTaskPayload.task.id }) },
    );
    const crossFlowResponse = await flowByIdRouteB.GET(
      new Request(`http://localhost/api/worker/orchestra/flows/${createFlowPayload.flow.id}`),
      { params: Promise.resolve({ id: createFlowPayload.flow.id }) },
    );

    expect(crossTaskResponse.status).toBe(404);
    expect(crossFlowResponse.status).toBe(404);
  });

  it('returns 401 when request user context is missing', async () => {
    mockUserContext(null);
    const workerRoute = await loadWorkerRootRoute();
    const response = await workerRoute.GET(new Request('http://localhost/api/worker'));

    expect(response.status).toBe(401);
  });
});
