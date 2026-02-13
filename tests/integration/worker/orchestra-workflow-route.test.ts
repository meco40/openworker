import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

function mockUserContext(context: { userId: string; authenticated: boolean } | null): void {
  vi.doMock('../../../src/server/auth/userContext', () => ({
    resolveRequestUserContext: vi.fn().mockResolvedValue(context),
  }));
}

async function loadWorkflowRoute() {
  return import('../../../app/api/worker/[id]/workflow/route');
}

async function loadWorkerRepository() {
  return import('../../../src/server/worker/workerRepository');
}

describe('orchestra workflow route', () => {
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

  it('returns live workflow graph for the current run', async () => {
    const dbPath = path.join(
      process.cwd(),
      '.local',
      `worker.orchestra.workflow.${Date.now()}.${Math.random().toString(36).slice(2)}.db`,
    );
    cleanupPaths.push(dbPath);
    process.env.WORKER_DB_PATH = dbPath;
    mockUserContext({ userId: 'user-a', authenticated: true });

    const { getWorkerRepository } = await loadWorkerRepository();
    const repo = getWorkerRepository();
    const task = repo.createTask({
      title: 'Workflow route task',
      objective: 'Exercise workflow route',
      originPlatform: 'WebChat' as never,
      originConversation: 'conv-user-a',
      userId: 'user-a',
    });

    const draft = repo.createFlowDraft({
      userId: 'user-a',
      workspaceType: 'research',
      name: 'Workflow Flow',
      graphJson: JSON.stringify({
        startNodeId: 'n1',
        nodes: [
          { id: 'n1', personaId: 'persona-a' },
          { id: 'n2', personaId: 'persona-b' },
        ],
        edges: [{ from: 'n1', to: 'n2' }],
      }),
    });
    const published = repo.publishFlowDraft(draft.id, 'user-a');
    expect(published).not.toBeNull();

    const run = repo.createRun({
      taskId: task.id,
      userId: 'user-a',
      flowPublishedId: published!.id,
      status: 'running',
    });
    repo.setTaskRunContext(task.id, {
      flowPublishedId: published!.id,
      currentRunId: run.id,
    });
    repo.upsertRunNodeStatus(run.id, 'n1', { status: 'completed' });
    repo.upsertRunNodeStatus(run.id, 'n2', { status: 'running' });

    const route = await loadWorkflowRoute();
    const response = await route.GET(
      new Request(`http://localhost/api/worker/${task.id}/workflow`),
      { params: Promise.resolve({ id: task.id }) },
    );
    const payload = (await response.json()) as {
      ok: boolean;
      workflow: {
        taskId: string;
        nodes: Array<{ id: string; status: string }>;
        edges: Array<{ from: string; to: string }>;
        currentNodeId: string | null;
      };
    };

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.workflow.taskId).toBe(task.id);
    expect(payload.workflow.nodes.find((node) => node.id === 'n1')?.status).toBe('completed');
    expect(payload.workflow.nodes.find((node) => node.id === 'n2')?.status).toBe('running');
    expect(payload.workflow.currentNodeId).toBe('n2');
    expect(payload.workflow.edges).toHaveLength(1);
  });
});
