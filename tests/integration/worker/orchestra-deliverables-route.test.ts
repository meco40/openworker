import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

function mockUserContext(context: { userId: string; authenticated: boolean } | null): void {
  vi.doMock('../../../src/server/auth/userContext', () => ({
    resolveRequestUserContext: vi.fn().mockResolvedValue(context),
  }));
}

async function loadDeliverablesRoute() {
  return import('../../../app/api/worker/[id]/deliverables/route');
}

async function loadWorkerRepository() {
  return import('../../../src/server/worker/workerRepository');
}

describe('orchestra deliverables route', () => {
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

  it('stores deliverables and bridges legacy artifacts', async () => {
    const dbPath = path.join(
      process.cwd(),
      '.local',
      `worker.orchestra.deliverables.${Date.now()}.${Math.random().toString(36).slice(2)}.db`,
    );
    cleanupPaths.push(dbPath);
    process.env.WORKER_DB_PATH = dbPath;
    mockUserContext({ userId: 'user-a', authenticated: true });

    const { getWorkerRepository } = await loadWorkerRepository();
    const repo = getWorkerRepository();
    const task = repo.createTask({
      title: 'Deliverables test task',
      objective: 'Exercise deliverables APIs',
      originPlatform: 'WebChat' as never,
      originConversation: 'conv-user-a',
      userId: 'user-a',
    });
    repo.saveArtifact({
      taskId: task.id,
      name: 'legacy-summary.md',
      type: 'doc',
      content: '# Legacy Artifact',
      mimeType: 'text/markdown',
    });

    const route = await loadDeliverablesRoute();
    const createResponse = await route.POST(
      new Request(`http://localhost/api/worker/${task.id}/deliverables`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'final-report.md',
          type: 'file',
          content: '# Final Report',
          mimeType: 'text/markdown',
        }),
      }),
      { params: Promise.resolve({ id: task.id }) },
    );
    expect(createResponse.status).toBe(201);

    const listResponse = await route.GET(
      new Request(`http://localhost/api/worker/${task.id}/deliverables`),
      { params: Promise.resolve({ id: task.id }) },
    );
    const listPayload = (await listResponse.json()) as {
      ok: boolean;
      deliverables: Array<{ name: string; source: string }>;
    };
    expect(listResponse.status).toBe(200);
    expect(listPayload.ok).toBe(true);
    expect(listPayload.deliverables.some((item) => item.name === 'final-report.md')).toBe(true);
    expect(listPayload.deliverables.some((item) => item.name === 'legacy-summary.md')).toBe(true);
  });
});
