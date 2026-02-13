import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

function mockUserContext(context: { userId: string; authenticated: boolean } | null): void {
  vi.doMock('../../../src/server/auth/userContext', () => ({
    resolveRequestUserContext: vi.fn().mockResolvedValue(context),
  }));
}

async function loadSubagentsRoute() {
  return import('../../../app/api/worker/[id]/subagents/route');
}

async function loadWorkerRepository() {
  return import('../../../src/server/worker/workerRepository');
}

describe('orchestra subagent sessions route', () => {
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

  it('creates, updates and lists subagent sessions', async () => {
    const dbPath = path.join(
      process.cwd(),
      '.local',
      `worker.orchestra.subagents.${Date.now()}.${Math.random().toString(36).slice(2)}.db`,
    );
    cleanupPaths.push(dbPath);
    process.env.WORKER_DB_PATH = dbPath;
    mockUserContext({ userId: 'user-a', authenticated: true });

    const { getWorkerRepository } = await loadWorkerRepository();
    const repo = getWorkerRepository();
    const task = repo.createTask({
      title: 'Subagent test task',
      objective: 'Exercise subagent session APIs',
      originPlatform: 'WebChat' as never,
      originConversation: 'conv-user-a',
      userId: 'user-a',
    });

    const route = await loadSubagentsRoute();
    const createResponse = await route.POST(
      new Request(`http://localhost/api/worker/${task.id}/subagents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          runId: 'run-1',
          nodeId: 'node-a',
          personaId: 'persona-research',
          sessionRef: 'agent-session-1',
        }),
      }),
      { params: Promise.resolve({ id: task.id }) },
    );
    const createPayload = (await createResponse.json()) as { ok: boolean; session: { id: string } };
    expect(createResponse.status).toBe(201);
    expect(createPayload.ok).toBe(true);

    const updateResponse = await route.PATCH(
      new Request(`http://localhost/api/worker/${task.id}/subagents`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: createPayload.session.id,
          status: 'completed',
        }),
      }),
      { params: Promise.resolve({ id: task.id }) },
    );
    expect(updateResponse.status).toBe(200);

    const listResponse = await route.GET(
      new Request(`http://localhost/api/worker/${task.id}/subagents`),
      { params: Promise.resolve({ id: task.id }) },
    );
    const listPayload = (await listResponse.json()) as {
      ok: boolean;
      sessions: Array<{ id: string; status: string }>;
    };
    expect(listResponse.status).toBe(200);
    expect(listPayload.ok).toBe(true);
    expect(listPayload.sessions).toHaveLength(1);
    expect(listPayload.sessions[0].status).toBe('completed');
  });
});
