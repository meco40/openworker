import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

function mockUserContext(context: { userId: string; authenticated: boolean } | null): void {
  vi.doMock('../../../src/server/auth/userContext', () => ({
    resolveRequestUserContext: vi.fn().mockResolvedValue(context),
  }));
}

async function loadFlowsRoute() {
  return import('../../../app/api/worker/orchestra/flows/route');
}

async function loadPublishRoute() {
  return import('../../../app/api/worker/orchestra/flows/[id]/publish/route');
}

function makeGraph() {
  return {
    startNodeId: 'n1',
    nodes: [
      { id: 'n1', personaId: 'persona-a', position: { x: 0, y: 0 } },
      { id: 'n2', personaId: 'persona-b', position: { x: 0, y: 100 } },
    ],
    edges: [{ id: 'e1', from: 'n1', to: 'n2' }],
  };
}

describe('orchestra policy route integration', () => {
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

  it('enforces role-based write and publish permissions', async () => {
    const dbPath = path.join(
      process.cwd(),
      '.local',
      `worker.orchestra.policy.${Date.now()}.${Math.random().toString(36).slice(2)}.db`,
    );
    cleanupPaths.push(dbPath);
    process.env.WORKER_DB_PATH = dbPath;
    mockUserContext({ userId: 'user-a', authenticated: true });

    const flowsRoute = await loadFlowsRoute();
    const publishRoute = await loadPublishRoute();

    const viewerCreate = await flowsRoute.POST(
      new Request('http://localhost/api/worker/orchestra/flows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-worker-role': 'viewer' },
        body: JSON.stringify({
          name: 'Policy Flow',
          workspaceType: 'research',
          graph: makeGraph(),
        }),
      }),
    );
    expect(viewerCreate.status).toBe(403);

    const devCreate = await flowsRoute.POST(
      new Request('http://localhost/api/worker/orchestra/flows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-worker-role': 'dev' },
        body: JSON.stringify({
          name: 'Policy Flow',
          workspaceType: 'research',
          graph: makeGraph(),
        }),
      }),
    );
    const devPayload = (await devCreate.json()) as { ok: boolean; flow: { id: string } };
    expect(devCreate.status).toBe(201);
    expect(devPayload.ok).toBe(true);

    const viewerPublish = await publishRoute.POST(
      new Request(`http://localhost/api/worker/orchestra/flows/${devPayload.flow.id}/publish`, {
        method: 'POST',
        headers: { 'x-worker-role': 'viewer' },
      }),
      { params: Promise.resolve({ id: devPayload.flow.id }) },
    );
    expect(viewerPublish.status).toBe(403);

    const adminPublish = await publishRoute.POST(
      new Request(`http://localhost/api/worker/orchestra/flows/${devPayload.flow.id}/publish`, {
        method: 'POST',
        headers: { 'x-worker-role': 'admin' },
      }),
      { params: Promise.resolve({ id: devPayload.flow.id }) },
    );
    expect(adminPublish.status).toBe(200);
  });
});
