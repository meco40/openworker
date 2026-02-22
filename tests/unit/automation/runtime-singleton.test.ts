import { afterEach, describe, expect, it, vi } from 'vitest';

type RuntimeGlobals = typeof globalThis & {
  __automationRepository?: unknown;
  __automationService?: unknown;
};

function resetAutomationGlobals(): void {
  (globalThis as RuntimeGlobals).__automationRepository = undefined;
  (globalThis as RuntimeGlobals).__automationService = undefined;
  (globalThis as { __automationRuntime?: unknown }).__automationRuntime = undefined;
}

function mockAutomationRepository(acquireLeaseImpl: () => boolean = () => false): void {
  vi.doMock('../../../src/server/automation/sqliteAutomationRepository', () => ({
    SqliteAutomationRepository: class {
      acquireLease = vi.fn(() => acquireLeaseImpl());
      releaseLease = vi.fn();
    },
  }));
}

describe('automation runtime singletons', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    resetAutomationGlobals();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('uses existing global runtime instance for start/stop', async () => {
    resetAutomationGlobals();
    const start = vi.fn();
    const stop = vi.fn();
    (globalThis as { __automationRuntime?: unknown }).__automationRuntime = { start, stop };

    const runtimeModule = await import('@/server/automation/runtime');
    const runtime = runtimeModule.startAutomationRuntime('ignored');
    runtimeModule.stopAutomationRuntime();

    expect(runtime).toBe((globalThis as { __automationRuntime?: unknown }).__automationRuntime);
    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('creates singleton service/runtime and parses retry backoff from env', async () => {
    resetAutomationGlobals();
    process.env.AUTOMATION_RETRY_BACKOFF_MS = '10, invalid, -1, 20';
    process.env.AUTOMATION_TICK_INTERVAL_MS = '2222';
    process.env.AUTOMATION_LEASE_TTL_MS = '3333';
    process.env.AUTOMATION_MAX_ATTEMPTS = '4';
    process.env.AUTOMATION_AUTO_PAUSE_FAILURES = '7';

    mockAutomationRepository(() => false);
    const runtimeModule = await import('@/server/automation/runtime');

    const serviceA = runtimeModule.getAutomationService();
    const serviceB = runtimeModule.getAutomationService();
    expect(serviceA).toBe(serviceB);

    const runtime = runtimeModule.startAutomationRuntime('scheduler-env');
    const internal = runtime as unknown as {
      tickIntervalMs: number;
      leaseTtlMs: number;
      maxAttempts: number;
      retryBackoffMs: number[];
      autoPauseFailureThreshold: number;
    };
    expect(internal.tickIntervalMs).toBe(2222);
    expect(internal.leaseTtlMs).toBe(3333);
    expect(internal.maxAttempts).toBe(4);
    expect(internal.retryBackoffMs).toEqual([10, 20]);
    expect(internal.autoPauseFailureThreshold).toBe(7);

    runtimeModule.stopAutomationRuntime();
  });

  it('default runPrompt uses default conversation, truncates summary, and handles abort', async () => {
    resetAutomationGlobals();

    const getDefaultWebChatConversation = vi.fn(() => ({ id: 'conv-default' }));
    const abortGeneration = vi.fn();
    const handleWebUIMessage = vi.fn(async () => ({
      agentMsg: {
        content: 'x'.repeat(600),
      },
    }));

    mockAutomationRepository(() => false);
    vi.doMock('../../../src/server/channels/messages/runtime', () => ({
      getMessageService: () => ({
        getDefaultWebChatConversation,
        abortGeneration,
        handleWebUIMessage,
      }),
    }));

    const runtimeModule = await import('@/server/automation/runtime');
    const service = runtimeModule.getAutomationService() as unknown as {
      deps: {
        runPrompt: (input: {
          userId: string;
          prompt: string;
          conversationId?: string | null;
          signal?: AbortSignal;
        }) => Promise<{ summary?: string }>;
      };
    };

    const result = await service.deps.runPrompt({
      userId: 'legacy-local-user',
      prompt: 'Send summary',
    });
    expect(getDefaultWebChatConversation).toHaveBeenCalledWith('legacy-local-user');
    expect(handleWebUIMessage).toHaveBeenCalledWith(
      'conv-default',
      'Send summary',
      'legacy-local-user',
      expect.stringMatching(/^automation-/),
    );
    expect(result.summary?.length).toBe(500);

    const aborted = new AbortController();
    aborted.abort();
    await expect(
      service.deps.runPrompt({
        userId: 'legacy-local-user',
        prompt: 'Will abort',
        conversationId: 'conv-explicit',
        signal: aborted.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(abortGeneration).toHaveBeenCalledWith('conv-explicit');
  });
});
