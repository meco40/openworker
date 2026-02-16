import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteWorkerRepository } from '../../../src/server/worker/workerRepository';
import type { WorkerTaskRecord } from '../../../src/server/worker/workerTypes';

function makeTask(repo: SqliteWorkerRepository): WorkerTaskRecord {
  return repo.createTask({
    title: 'Rate',
    objective: 'rate limit enforcement',
    originPlatform: 'WebChat' as never,
    originConversation: 'conv-rate',
    workspaceType: 'general',
    userId: 'user-rate',
  });
}

describe('openai rate limit', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env.OPENAI_WORKER_MAX_REQ_PER_MIN_PER_USER = '1';
    process.env.OPENAI_WORKER_MAX_TOKENS_PER_RUN = '10000';
  });

  it('interrupts second run in same minute with retry hint', async () => {
    const repo = new SqliteWorkerRepository(':memory:');
    const taskA = makeTask(repo);
    const taskB = makeTask(repo);

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
    vi.doMock('../../../src/server/worker/openai/openaiWorkerClient', () => ({
      getOpenAiWorkerClient: () => ({
        startRun: vi.fn().mockResolvedValue({
          runId: 'run-ok',
          status: 'completed',
          output: 'ok',
        }),
        cancelRun: vi.fn(),
        submitApproval: vi.fn(),
      }),
    }));

    const runtime = await import('../../../src/server/worker/openai/openaiWorkerRuntime');
    runtime.resetOpenAiRuntimeStateForTests();

    await runtime.executeOpenAiRuntimeTask(taskA);
    await runtime.executeOpenAiRuntimeTask(taskB);

    const updatedSecond = repo.getTask(taskB.id)!;
    expect(updatedSecond.status).toBe('interrupted');
    expect(updatedSecond.errorMessage).toContain('rate limit');
  });
});
