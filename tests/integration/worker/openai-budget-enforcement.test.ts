import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteWorkerRepository } from '../../../src/server/worker/workerRepository';
import type { WorkerTaskRecord } from '../../../src/server/worker/workerTypes';

function makeTask(repo: SqliteWorkerRepository): WorkerTaskRecord {
  return repo.createTask({
    title: 'Budget',
    objective: 'budget enforcement',
    originPlatform: 'WebChat' as never,
    originConversation: 'conv-budget',
    workspaceType: 'general',
    userId: 'user-budget',
  });
}

describe('openai budget enforcement', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env.OPENAI_WORKER_MAX_TOKENS_PER_RUN = '10';
  });

  it('rejects run when token budget would be exceeded', async () => {
    const repo = new SqliteWorkerRepository(':memory:');
    const task = makeTask(repo);

    vi.doMock('../../../src/server/worker/workerRepository', () => ({
      getWorkerRepository: () => repo,
    }));
    vi.doMock('../../../src/server/gateway/broadcast', () => ({
      broadcast: vi.fn(),
    }));
    vi.doMock('../../../src/server/worker/workerCallback', () => ({
      notifyTaskCompleted: vi.fn().mockResolvedValue(undefined),
      notifyTaskFailed: vi.fn().mockResolvedValue(undefined),
      notifyApprovalRequest: vi.fn().mockResolvedValue(undefined),
    }));

    const runtime = await import('../../../src/server/worker/openai/openaiWorkerRuntime');
    await runtime.executeOpenAiRuntimeTask(task);

    const updated = repo.getTask(task.id)!;
    expect(updated.status).toBe('failed');
    expect(updated.errorMessage).toContain('run_token_limit');
  });
});
