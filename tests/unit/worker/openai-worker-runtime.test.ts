import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteWorkerRepository } from '../../../src/server/worker/workerRepository';
import type { WorkerTaskRecord } from '../../../src/server/worker/workerTypes';

function makeTask(repo: SqliteWorkerRepository): WorkerTaskRecord {
  return repo.createTask({
    title: 'OpenAI Runtime Task',
    objective: 'Validate runtime adapter',
    originPlatform: 'WebChat' as never,
    originConversation: 'conv-openai-runtime',
    workspaceType: 'general',
  });
}

describe('openai worker runtime budget/rate helpers', () => {
  beforeEach(async () => {
    const runtime = await import('../../../src/server/worker/openai/openaiWorkerRuntime');
    runtime.resetOpenAiRuntimeStateForTests();
    process.env.OPENAI_WORKER_MAX_TOKENS_PER_RUN = '100';
    process.env.OPENAI_WORKER_MAX_COST_USD_PER_RUN = '1';
    process.env.OPENAI_WORKER_MAX_COST_USD_PER_USER_PER_DAY = '2';
    process.env.OPENAI_WORKER_MAX_REQ_PER_MIN_PER_USER = '2';
  });

  it('rejects budget overflow and enforces per-minute rate limits', async () => {
    const runtime = await import('../../../src/server/worker/openai/openaiWorkerRuntime');

    expect(
      runtime.checkBudget({
        userId: 'user-a',
        projectedTokens: 101,
        projectedCostUsd: 0.1,
      }),
    ).toEqual({ ok: false, reason: 'run_token_limit' });

    expect(runtime.checkRateLimit('user-a', 0).ok).toBe(true);
    expect(runtime.checkRateLimit('user-a', 1).ok).toBe(true);
    const limited = runtime.checkRateLimit('user-a', 2);
    expect(limited.ok).toBe(false);
    expect(limited.retryAfterSec).toBeGreaterThan(0);
  });
});

describe('openai worker runtime execution', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env.WORKER_RUNTIME = 'openai';
    process.env.OPENAI_WORKER_MAX_TOKENS_PER_RUN = '10000';
    process.env.OPENAI_WORKER_MAX_COST_USD_PER_RUN = '100';
    process.env.OPENAI_WORKER_MAX_COST_USD_PER_USER_PER_DAY = '1000';
    process.env.OPENAI_WORKER_MAX_REQ_PER_MIN_PER_USER = '100';
  });

  it('completes task when sidecar returns completed', async () => {
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
        startRun: vi.fn().mockResolvedValue({
          runId: 'run-1',
          status: 'completed',
          output: 'done',
        }),
        cancelRun: vi.fn(),
        submitApproval: vi.fn(),
      }),
    }));

    const runtime = await import('../../../src/server/worker/openai/openaiWorkerRuntime');
    await runtime.executeOpenAiRuntimeTask(task);

    const updated = repo.getTask(task.id)!;
    expect(updated.status).toBe('completed');
    expect(updated.resultSummary).toContain('done');
  });

  it('passes enabled OpenAI worker tools to sidecar startRun', async () => {
    const repo = new SqliteWorkerRepository(':memory:');
    const task = makeTask(repo);
    const startRun = vi.fn().mockResolvedValue({
      runId: 'run-tools',
      status: 'completed',
      output: 'done',
    });

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
    vi.doMock('../../../src/server/worker/openai/openaiToolRegistry', () => ({
      resolveEnabledOpenAiWorkerToolNamesFromConfig: vi
        .fn()
        .mockReturnValue(['safe_browser', 'safe_files']),
      resolveOpenAiWorkerToolApprovalPolicyFromConfig: vi.fn().mockReturnValue({
        defaultMode: 'ask_approve',
        byFunctionName: {
          safe_browser: 'approve_always',
          safe_files: 'ask_approve',
        },
      }),
    }));

    const runtime = await import('../../../src/server/worker/openai/openaiWorkerRuntime');
    await runtime.executeOpenAiRuntimeTask(task, {
      startRun,
      cancelRun: vi.fn(),
      submitApproval: vi.fn(),
    });

    expect(startRun).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: task.id,
        enabledTools: ['safe_browser', 'safe_files'],
        toolApprovalPolicy: {
          defaultMode: 'ask_approve',
          byFunctionName: {
            safe_browser: 'approve_always',
            safe_files: 'ask_approve',
          },
        },
      }),
    );
  });

  it('standardTaskPhase delegates to openai runtime when enabled', async () => {
    vi.doMock('../../../src/server/worker/openai/openaiWorkerRuntime', () => ({
      isOpenAiRuntimeEnabled: vi.fn().mockResolvedValue(true),
      executeOpenAiRuntimeTask: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('../../../src/server/worker/workerRepository', () => ({
      getWorkerRepository: () => ({
        getSteps: () => [],
        saveCheckpoint: vi.fn(),
      }),
    }));

    const phase = await import('../../../src/server/worker/phases/standardTaskPhase');
    const task = {
      id: 'task-x',
      title: 'x',
      objective: 'y',
      status: 'queued',
      priority: 'normal',
      originPlatform: 'WebChat',
      originConversation: 'conv',
      originExternalChat: null,
      currentStep: 0,
      totalSteps: 0,
      resultSummary: null,
      errorMessage: null,
      resumable: false,
      lastCheckpoint: null,
      workspacePath: null,
      workspaceType: 'general',
      assignedPersonaId: null,
      planningMessages: null,
      planningComplete: false,
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
    } as unknown as WorkerTaskRecord;

    await phase.executeStandardTaskPhase(task, 0, 'general');

    const runtime = await import('../../../src/server/worker/openai/openaiWorkerRuntime');
    expect(runtime.executeOpenAiRuntimeTask).toHaveBeenCalledWith(task);
  });

  it('resolves persona model routing from assigned persona', async () => {
    vi.doUnmock('../../../src/server/worker/openai/openaiWorkerRuntime');
    const task = {
      id: 'task-1',
      title: 'Routing',
      objective: 'Resolve model routing',
      status: 'queued',
      priority: 'normal',
      originPlatform: 'WebChat',
      originConversation: 'conv-1',
      originExternalChat: null,
      currentStep: 0,
      totalSteps: 0,
      resultSummary: null,
      errorMessage: null,
      resumable: false,
      lastCheckpoint: null,
      workspacePath: null,
      workspaceType: 'general',
      userId: 'user-a',
      flowPublishedId: null,
      currentRunId: null,
      assignedPersonaId: 'persona-architect',
      planningMessages: null,
      planningComplete: false,
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
    } as unknown as WorkerTaskRecord;

    vi.doMock('../../../src/server/personas/personaRepository', () => ({
      getPersonaRepository: () => ({
        getPersona: () => ({
          id: 'persona-architect',
          userId: 'user-a',
          preferredModelId: 'gpt-4o-mini',
          modelHubProfileId: 'team-a',
        }),
      }),
    }));

    const runtime = await import('../../../src/server/worker/openai/openaiWorkerRuntime');
    const routing = await runtime.resolveTaskModelRouting(task);

    expect(routing).toEqual({
      personaId: 'persona-architect',
      preferredModelId: 'gpt-4o-mini',
      modelHubProfileId: 'team-a',
    });
  });
});

