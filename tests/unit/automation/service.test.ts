import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AutomationRepository } from '@/server/automation/repository';
import { AutomationService } from '@/server/automation/service';
import type { AutomationRule, AutomationRun, SchedulerLeaseState } from '@/server/automation/types';

function buildRule(overrides: Partial<AutomationRule> = {}): AutomationRule {
  const now = '2026-02-22T00:00:00.000Z';
  return {
    id: 'rule-1',
    userId: 'user-1',
    name: 'Rule',
    cronExpression: '* * * * *',
    timezone: 'UTC',
    prompt: 'Do the thing',
    enabled: true,
    nextRunAt: '2026-02-22T00:01:00.000Z',
    lastRunAt: null,
    consecutiveFailures: 0,
    lastError: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function buildRun(overrides: Partial<AutomationRun> = {}): AutomationRun {
  const now = '2026-02-22T00:00:00.000Z';
  return {
    id: 'run-1',
    ruleId: 'rule-1',
    userId: 'user-1',
    triggerSource: 'cron',
    scheduledFor: '2026-02-22T00:00:00.000Z',
    runKey: 'rule-1:2026-02-22T00:00:00.000Z',
    status: 'queued',
    attempt: 0,
    nextAttemptAt: now,
    errorMessage: null,
    resultSummary: null,
    startedAt: null,
    finishedAt: null,
    createdAt: now,
    ...overrides,
  };
}

function createMockRepository(overrides: Partial<AutomationRepository> = {}): AutomationRepository {
  return {
    createRule: vi.fn((input) =>
      buildRule({
        userId: input.userId,
        name: input.name,
        cronExpression: input.cronExpression,
        timezone: input.timezone,
        prompt: input.prompt,
        enabled: input.enabled,
        nextRunAt: input.nextRunAt ?? null,
      }),
    ),
    updateRule: vi.fn(() => null),
    deleteRule: vi.fn(() => true),
    getRule: vi.fn(() => null),
    getRuleById: vi.fn(() => null),
    listRules: vi.fn(() => []),
    listDueRules: vi.fn(() => []),
    createOrGetRun: vi.fn((input) =>
      buildRun({
        ruleId: input.ruleId,
        userId: input.userId,
        triggerSource: input.triggerSource,
        scheduledFor: input.scheduledFor,
        runKey: input.runKey,
        attempt: input.attempt ?? 0,
        nextAttemptAt: input.nextAttemptAt ?? null,
      }),
    ),
    getRun: vi.fn(() => null),
    listRuns: vi.fn(() => []),
    listQueuedRunsDue: vi.fn(() => []),
    markRunRunning: vi.fn((runId, startedAt) =>
      buildRun({ id: runId, status: 'running', startedAt }),
    ),
    markRunSucceeded: vi.fn((runId, finishedAt, summary) =>
      buildRun({ id: runId, status: 'succeeded', finishedAt, resultSummary: summary ?? null }),
    ),
    markRunForRetry: vi.fn((runId, attempt, errorMessage, nextAttemptAt) =>
      buildRun({
        id: runId,
        status: 'queued',
        attempt,
        errorMessage,
        nextAttemptAt,
      }),
    ),
    markRunDeadLetter: vi.fn((runId, errorMessage, finishedAt) =>
      buildRun({
        id: runId,
        status: 'dead_letter',
        errorMessage,
        finishedAt,
      }),
    ),
    recordDeadLetter: vi.fn(() => ({
      id: 'dl-1',
      runId: 'run-1',
      ruleId: 'rule-1',
      reason: 'reason',
      payload: null,
      createdAt: '2026-02-22T00:00:00.000Z',
    })),
    countActiveRules: vi.fn(() => 0),
    countRunsByStatus: vi.fn(() => 0),
    acquireLease: vi.fn(() => true),
    releaseLease: vi.fn(),
    getLeaseState: vi.fn(() => null as SchedulerLeaseState | null),
    close: vi.fn(),
    ...overrides,
  };
}

describe('AutomationService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('validates timezone and cron expression when creating a rule', () => {
    const repo = createMockRepository();
    const service = new AutomationService(repo, {
      runPrompt: async () => ({ summary: 'ok' }),
    });

    expect(() =>
      service.createRule({
        userId: 'user-1',
        name: 'Invalid timezone',
        cronExpression: '* * * * *',
        timezone: 'Invalid/Timezone',
        prompt: 'x',
        enabled: true,
      }),
    ).toThrow('Invalid timezone: Invalid/Timezone');

    expect(() =>
      service.createRule({
        userId: 'user-1',
        name: 'Invalid cron',
        cronExpression: 'not-a-cron',
        timezone: 'UTC',
        prompt: 'x',
        enabled: true,
      }),
    ).toThrow('Invalid cron expression');
  });

  it('keeps explicit nextRunAt and nulls it for disabled rules', () => {
    const repo = createMockRepository();
    const service = new AutomationService(repo, {
      runPrompt: async () => ({ summary: 'ok' }),
    });

    const explicitNext = '2026-02-22T08:00:00.000Z';
    const explicit = service.createRule({
      userId: 'user-1',
      name: 'Explicit',
      cronExpression: '* * * * *',
      timezone: 'UTC',
      prompt: 'x',
      enabled: true,
      nextRunAt: explicitNext,
    });
    expect(explicit.nextRunAt).toBe(explicitNext);

    const disabled = service.createRule({
      userId: 'user-1',
      name: 'Disabled',
      cronExpression: '* * * * *',
      timezone: 'UTC',
      prompt: 'x',
      enabled: false,
    });
    expect(disabled.nextRunAt).toBeNull();
  });

  it('returns null when updating a non-existing rule', () => {
    const repo = createMockRepository({
      getRule: vi.fn(() => null),
    });
    const service = new AutomationService(repo, {
      runPrompt: async () => ({ summary: 'ok' }),
    });

    const updated = service.updateRule('missing', 'user-1', { enabled: true });
    expect(updated).toBeNull();
  });

  it('updates rule state and clears lastError when enabling', () => {
    const existing = buildRule({
      enabled: false,
      lastError: 'previous failure',
      nextRunAt: null,
    });
    const updated = buildRule({
      enabled: true,
      lastError: null,
      nextRunAt: '2026-02-22T00:05:00.000Z',
    });
    const repo = createMockRepository({
      getRule: vi.fn(() => existing),
      updateRule: vi.fn(() => updated),
    });
    const service = new AutomationService(repo, {
      runPrompt: async () => ({ summary: 'ok' }),
    });

    const result = service.updateRule(existing.id, existing.userId, { enabled: true });
    expect(result).toBe(updated);

    const patchArg = (repo.updateRule as ReturnType<typeof vi.fn>).mock.calls[0]?.[2] as {
      nextRunAt?: string | null;
      lastError?: string | null;
      enabled?: boolean;
    };
    expect(patchArg.enabled).toBe(true);
    expect(patchArg.lastError).toBeNull();
    expect(typeof patchArg.nextRunAt).toBe('string');
  });

  it('creates manual runs and rejects unknown rule ids', () => {
    const rule = buildRule();
    const repo = createMockRepository({
      getRule: vi.fn().mockReturnValueOnce(null).mockReturnValueOnce(rule),
    });
    const service = new AutomationService(repo, {
      runPrompt: async () => ({ summary: 'ok' }),
    });

    expect(() => service.createManualRun('missing', rule.userId)).toThrow(
      'Automation rule not found',
    );

    const run = service.createManualRun(rule.id, rule.userId);
    expect(run.triggerSource).toBe('manual');
    expect(run.runKey.endsWith(':manual')).toBe(true);
  });

  it('reports metrics including lease age and run counters', () => {
    const now = new Date('2026-02-22T00:00:10.000Z').getTime();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const repo = createMockRepository({
      getLeaseState: vi.fn(() => ({
        singletonKey: 'automation-runtime',
        instanceId: 'scheduler-1',
        heartbeatAt: '2026-02-22T00:00:00.000Z',
        updatedAt: '2026-02-22T00:00:05.000Z',
      })),
      countActiveRules: vi.fn(() => 3),
      countRunsByStatus: vi.fn((status) => {
        if (status === 'queued') return 2;
        if (status === 'running') return 1;
        if (status === 'dead_letter') return 4;
        return 0;
      }),
    });
    const service = new AutomationService(repo, {
      runPrompt: async () => ({ summary: 'ok' }),
    });

    expect(service.getMetrics()).toEqual({
      activeRules: 3,
      queuedRuns: 2,
      runningRuns: 1,
      deadLetterRuns: 4,
      leaseAgeSeconds: 5,
    });
  });

  it('processTick enqueues due rules and skips rules without nextRunAt', async () => {
    const dueRule = buildRule({
      id: 'rule-due',
      nextRunAt: '2026-02-22T00:00:00.000Z',
    });
    const repo = createMockRepository({
      listDueRules: vi.fn(() => [buildRule({ id: 'rule-skip', nextRunAt: null }), dueRule]),
      listQueuedRunsDue: vi.fn(() => []),
    });
    const service = new AutomationService(repo, {
      runPrompt: async () => ({ summary: 'ok' }),
    });

    await service.processTick({
      nowIso: '2026-02-22T00:00:00.000Z',
      maxAttempts: 3,
      retryBackoffMs: [1000],
      autoPauseFailureThreshold: 10,
    });

    expect(repo.createOrGetRun).toHaveBeenCalledTimes(1);
    expect(repo.updateRule).toHaveBeenCalledTimes(1);
    expect(repo.updateRule).toHaveBeenCalledWith('rule-due', dueRule.userId, {
      nextRunAt: '2026-02-22T00:01:00.000Z',
    });
  });

  it('moves queued runs to dead-letter when rule no longer exists', async () => {
    const run = buildRun({
      id: 'run-missing-rule',
      ruleId: 'missing-rule',
    });
    const repo = createMockRepository({
      listQueuedRunsDue: vi.fn(() => [run]),
      getRuleById: vi.fn(() => null),
    });
    const service = new AutomationService(repo, {
      runPrompt: async () => ({ summary: 'ok' }),
    });

    await service.processTick({
      nowIso: '2026-02-22T00:00:00.000Z',
      maxAttempts: 3,
      retryBackoffMs: [1000],
      autoPauseFailureThreshold: 10,
    });

    expect(repo.markRunDeadLetter).toHaveBeenCalledWith(
      run.id,
      'Rule no longer exists.',
      expect.any(String),
    );
    expect(repo.recordDeadLetter).toHaveBeenCalledWith(
      run.id,
      run.ruleId,
      'Rule no longer exists.',
    );
  });

  it('marks run succeeded and resets failure counters on successful execution', async () => {
    const rule = buildRule({
      id: 'rule-success',
      consecutiveFailures: 3,
      lastError: 'old',
    });
    const run = buildRun({
      id: 'run-success',
      ruleId: rule.id,
      scheduledFor: '2026-02-22T00:00:00.000Z',
    });
    const repo = createMockRepository({
      listQueuedRunsDue: vi.fn(() => [run]),
      getRuleById: vi.fn(() => rule),
    });
    const service = new AutomationService(repo, {
      runPrompt: async () => ({ summary: 'done' }),
    });

    await service.processTick({
      nowIso: '2026-02-22T00:00:00.000Z',
      maxAttempts: 3,
      retryBackoffMs: [1000],
      autoPauseFailureThreshold: 10,
    });

    expect(repo.markRunRunning).toHaveBeenCalledWith(run.id, expect.any(String));
    expect(repo.markRunSucceeded).toHaveBeenCalledWith(run.id, expect.any(String), 'done');
    expect(repo.updateRule).toHaveBeenCalledWith(rule.id, rule.userId, {
      consecutiveFailures: 0,
      lastError: null,
      lastRunAt: run.scheduledFor,
    });
  });

  it('dead-letters and auto-pauses rule after repeated failures at threshold', async () => {
    const rule = buildRule({
      id: 'rule-pause',
      enabled: true,
      nextRunAt: '2026-02-22T00:05:00.000Z',
      consecutiveFailures: 1,
    });
    const run = buildRun({
      id: 'run-pause',
      ruleId: rule.id,
      attempt: 2,
    });
    const repo = createMockRepository({
      listQueuedRunsDue: vi.fn(() => [run]),
      getRuleById: vi.fn(() => rule),
    });
    const service = new AutomationService(repo, {
      runPrompt: async () => {
        throw new Error('boom');
      },
    });

    await service.processTick({
      nowIso: '2026-02-22T00:00:00.000Z',
      maxAttempts: 3,
      retryBackoffMs: [1000],
      autoPauseFailureThreshold: 2,
    });

    expect(repo.markRunDeadLetter).toHaveBeenCalledWith(run.id, 'boom', expect.any(String));
    expect(repo.recordDeadLetter).toHaveBeenCalledWith(run.id, run.ruleId, 'boom');
    expect(repo.updateRule).toHaveBeenCalledWith(rule.id, rule.userId, {
      consecutiveFailures: 2,
      lastError: 'boom',
      enabled: false,
      nextRunAt: null,
    });
  });

  it('dead-letters without auto-pause when failures are below threshold', async () => {
    const rule = buildRule({
      id: 'rule-no-pause',
      enabled: true,
      nextRunAt: '2026-02-22T00:05:00.000Z',
      consecutiveFailures: 0,
    });
    const run = buildRun({
      id: 'run-no-pause',
      ruleId: rule.id,
      attempt: 2,
    });
    const repo = createMockRepository({
      listQueuedRunsDue: vi.fn(() => [run]),
      getRuleById: vi.fn(() => rule),
    });
    const service = new AutomationService(repo, {
      runPrompt: async () => {
        throw new Error('still failing');
      },
    });

    await service.processTick({
      nowIso: '2026-02-22T00:00:00.000Z',
      maxAttempts: 3,
      retryBackoffMs: [1000],
      autoPauseFailureThreshold: 5,
    });

    expect(repo.updateRule).toHaveBeenCalledWith(rule.id, rule.userId, {
      consecutiveFailures: 1,
      lastError: 'still failing',
      enabled: true,
      nextRunAt: rule.nextRunAt,
    });
  });

  it('marks run for retry with configured and fallback backoff', async () => {
    const now = new Date('2026-02-22T00:00:00.000Z').getTime();
    vi.spyOn(Date, 'now').mockReturnValue(now);

    const rule = buildRule({ id: 'rule-retry' });
    const firstRun = buildRun({ id: 'run-retry-1', ruleId: rule.id, attempt: 0 });
    const secondRun = buildRun({ id: 'run-retry-2', ruleId: rule.id, attempt: 1 });
    const repo = createMockRepository({
      listQueuedRunsDue: vi.fn(() => [firstRun, secondRun]),
      getRuleById: vi.fn(() => rule),
    });
    const service = new AutomationService(repo, {
      runPrompt: async () => {
        throw new Error('retryable');
      },
    });

    await service.processTick({
      nowIso: '2026-02-22T00:00:00.000Z',
      maxAttempts: 5,
      retryBackoffMs: [5_000],
      autoPauseFailureThreshold: 10,
    });
    expect(repo.markRunForRetry).toHaveBeenNthCalledWith(
      1,
      firstRun.id,
      1,
      'retryable',
      '2026-02-22T00:00:05.000Z',
    );
    expect(repo.markRunForRetry).toHaveBeenNthCalledWith(
      2,
      secondRun.id,
      2,
      'retryable',
      '2026-02-22T00:00:05.000Z',
    );

    (repo.listQueuedRunsDue as ReturnType<typeof vi.fn>).mockReturnValue([firstRun]);
    await service.processTick({
      nowIso: '2026-02-22T00:00:00.000Z',
      maxAttempts: 5,
      retryBackoffMs: [],
      autoPauseFailureThreshold: 10,
    });
    expect(repo.markRunForRetry).toHaveBeenLastCalledWith(
      firstRun.id,
      1,
      'retryable',
      '2026-02-22T00:00:01.000Z',
    );
  });
});
