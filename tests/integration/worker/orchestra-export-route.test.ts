import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

function mockUserContext(context: { userId: string; authenticated: boolean } | null): void {
  vi.doMock('../../../src/server/auth/userContext', () => ({
    resolveRequestUserContext: vi.fn().mockResolvedValue(context),
  }));
}

async function loadExportRoute() {
  return import('../../../app/api/worker/[id]/export/route');
}

async function loadWorkerRepository() {
  return import('../../../src/server/worker/workerRepository');
}

async function loadWorkspaceManager() {
  return import('../../../src/server/worker/workspaceManager');
}

describe('orchestra export route', () => {
  const cleanupPaths: string[] = [];
  const cleanupWorkspaces: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    delete process.env.WORKER_DB_PATH;

    for (const workspaceId of cleanupWorkspaces.splice(0, cleanupWorkspaces.length)) {
      const wsPath = path.join(process.cwd(), 'workspaces', workspaceId);
      try {
        if (fs.existsSync(wsPath)) {
          fs.rmSync(wsPath, { recursive: true, force: true });
        }
      } catch {
        // ignore cleanup lock
      }
    }

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

  it('exports deliverables first and includes deliverables manifest', async () => {
    const dbPath = path.join(
      process.cwd(),
      '.local',
      `worker.orchestra.export.${Date.now()}.${Math.random().toString(36).slice(2)}.db`,
    );
    cleanupPaths.push(dbPath);
    process.env.WORKER_DB_PATH = dbPath;
    mockUserContext({ userId: 'user-a', authenticated: true });

    const { getWorkerRepository } = await loadWorkerRepository();
    const { getWorkspaceManager } = await loadWorkspaceManager();
    const repo = getWorkerRepository();
    const ws = getWorkspaceManager();

    const task = repo.createTask({
      title: 'Export Task',
      objective: 'Test export route',
      originPlatform: 'WebChat' as never,
      originConversation: 'conv-user-a',
      userId: 'user-a',
    });
    cleanupWorkspaces.push(task.id);

    ws.createWorkspace(task.id, 'research');
    ws.writeFile(task.id, 'output/workspace.txt', 'workspace payload');
    repo.addDeliverable({
      taskId: task.id,
      type: 'file',
      name: 'final-report.md',
      content: '# Final Report',
      mimeType: 'text/markdown',
      metadata: { kind: 'report' },
    });
    repo.saveArtifact({
      taskId: task.id,
      name: 'legacy-notes.txt',
      type: 'doc',
      content: 'legacy artifact',
      mimeType: 'text/plain',
    });

    const route = await loadExportRoute();
    const response = await route.GET(
      new Request(`http://localhost/api/worker/${task.id}/export`),
      { params: Promise.resolve({ id: task.id }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/zip');

    const buffer = Buffer.from(await response.arrayBuffer());
    const zipText = buffer.toString('utf8');
    expect(zipText).toContain('deliverables.json');
    expect(zipText).toContain('final-report.md');
    expect(zipText).toContain('legacy-notes.txt');
  });
});
