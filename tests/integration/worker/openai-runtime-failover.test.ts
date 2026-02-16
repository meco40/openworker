import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteWorkerRepository } from '../../../src/server/worker/workerRepository';
import type { WorkerTaskRecord } from '../../../src/server/worker/workerTypes';

function makeTask(repo: SqliteWorkerRepository): WorkerTaskRecord {
  return repo.createTask({
    title: 'Failover',
    objective: 'simulate sidecar down',
    originPlatform: 'WebChat' as never,
    originConversation: 'conv-failover',
    workspaceType: 'general',
    userId: 'user-failover',
  });
}

describe('openai runtime failover', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env.OPENAI_WORKER_MAX_TOKENS_PER_RUN = '10000';
  });

  it('marks task interrupted when sidecar startRun fails', async () => {
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
      notifyRuntimeFailover: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('../../../src/server/worker/openai/openaiWorkerClient', () => ({
      getOpenAiWorkerClient: () => ({
        startRun: vi.fn().mockRejectedValue(new Error('sidecar unavailable')),
        cancelRun: vi.fn(),
        submitApproval: vi.fn(),
      }),
    }));

    const runtime = await import('../../../src/server/worker/openai/openaiWorkerRuntime');
    await runtime.executeOpenAiRuntimeTask(task);

    const updated = repo.getTask(task.id)!;
    expect(updated.status).toBe('interrupted');
    expect(updated.errorMessage).toContain('sidecar unavailable');
  });
});
