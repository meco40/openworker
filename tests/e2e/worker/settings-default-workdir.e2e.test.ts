import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

function mockUserContext(context: { userId: string; authenticated: boolean } | null): void {
  vi.doMock('../../../src/server/auth/userContext', () => ({
    resolveRequestUserContext: vi.fn().mockResolvedValue(context),
  }));
}

async function loadSettingsRoute() {
  return import('../../../app/api/worker/settings/route');
}

async function loadWorkerRepository() {
  return import('../../../src/server/worker/workerRepository');
}

async function loadWorkspacePhase() {
  return import('../../../src/server/worker/phases/workspacePhase');
}

describe('Worker E2E: settings default workdir', () => {
  const cleanupPaths: string[] = [];
  const cleanupDirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    delete process.env.WORKER_DB_PATH;

    for (const dirPath of cleanupDirs.splice(0, cleanupDirs.length)) {
      try {
        if (fs.existsSync(dirPath)) {
          fs.rmSync(dirPath, { recursive: true, force: true });
        }
      } catch {
        // ignore transient lock in tests
      }
    }

    for (const filePath of cleanupPaths.splice(0, cleanupPaths.length)) {
      for (const candidate of [filePath, `${filePath}-wal`, `${filePath}-shm`]) {
        try {
          if (fs.existsSync(candidate)) {
            fs.unlinkSync(candidate);
          }
        } catch {
          // ignore transient lock in tests
        }
      }
    }
  });

  it('creates each task workspace under configured default workspace root', async () => {
    const dbPath = path.join(
      process.cwd(),
      '.local',
      `worker.settings.e2e.${Date.now()}.${Math.random().toString(36).slice(2)}.db`,
    );
    const rootPath = path.join(
      process.cwd(),
      '.tmp',
      `worker-settings-root-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    cleanupPaths.push(dbPath);
    cleanupDirs.push(rootPath);
    process.env.WORKER_DB_PATH = dbPath;

    mockUserContext({ userId: 'user-settings-e2e', authenticated: true });

    const settingsRoute = await loadSettingsRoute();
    const putResponse = await settingsRoute.PUT(
      new Request('http://localhost/api/worker/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ defaultWorkspaceRoot: rootPath }),
      }),
    );
    expect(putResponse.status).toBe(200);

    const { getWorkerRepository } = await loadWorkerRepository();
    const { setupWorkspace } = await loadWorkspacePhase();
    const repo = getWorkerRepository();

    const taskA = repo.createTask({
      title: 'Task A',
      objective: 'Workspace under default root',
      originPlatform: 'WebChat' as never,
      originConversation: 'conv-settings-e2e',
      userId: 'user-settings-e2e',
    });
    const taskB = repo.createTask({
      title: 'Task B',
      objective: 'Second isolated workspace',
      originPlatform: 'WebChat' as never,
      originConversation: 'conv-settings-e2e',
      userId: 'user-settings-e2e',
    });

    const wsA = setupWorkspace(taskA.id, taskA.workspaceType);
    const wsB = setupWorkspace(taskB.id, taskB.workspaceType);

    const expectedA = path.join(rootPath, taskA.id);
    const expectedB = path.join(rootPath, taskB.id);

    expect(wsA.workspacePath).toBe(expectedA);
    expect(wsB.workspacePath).toBe(expectedB);
    expect(wsA.workspacePath).not.toBe(wsB.workspacePath);

    expect(fs.existsSync(path.join(expectedA, '.workspace.json'))).toBe(true);
    expect(fs.existsSync(path.join(expectedB, '.workspace.json'))).toBe(true);

    const persistedA = repo.getTask(taskA.id);
    const persistedB = repo.getTask(taskB.id);
    expect(persistedA?.workspacePath).toBe(expectedA);
    expect(persistedB?.workspacePath).toBe(expectedB);
  });
});
