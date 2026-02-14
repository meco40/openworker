import { afterEach, describe, expect, it, vi } from 'vitest';

type SecuritySnapshot = {
  checks: Array<{ id: string; status: 'ok' | 'warning' | 'critical'; detail: string }>;
  summary: { ok: number; warning: number; critical: number };
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  delete process.env.WHATSAPP_BRIDGE_URL;
  delete process.env.IMESSAGE_BRIDGE_URL;
  delete process.env.MESSAGES_DB_PATH;
  delete process.env.WORKER_DB_PATH;
  delete process.env.LOGS_DB_PATH;
  delete process.env.ALERT_WEBHOOK_URL;
  delete process.env.MEMORY_PROVIDER;
  delete process.env.MEM0_BASE_URL;
  delete process.env.MEM0_API_PATH;
  vi.unstubAllGlobals();
  globalThis.__credentialStore = undefined;
  globalThis.__logRepository = undefined;
  globalThis.__memoryService = undefined;
  globalThis.__mem0Client = undefined;
});

describe('runHealthCommand', () => {
  it('returns skipped integration checks when bridge URLs are not configured', async () => {
    const { runHealthCommand } = await import('../../../src/commands/healthCommand');
    const report = await runHealthCommand();

    expect(report.summary.skipped).toBeGreaterThanOrEqual(2);
    expect(report.checks.find((c) => c.id === 'integration.whatsapp_bridge')?.status).toBe(
      'skipped',
    );
    expect(report.checks.find((c) => c.id === 'integration.imessage_bridge')?.status).toBe(
      'skipped',
    );
    expect(['ok', 'degraded', 'critical']).toContain(report.status);
  });

  it('marks report as degraded when a configured bridge health check fails', async () => {
    process.env.MESSAGES_DB_PATH = ':memory:';
    process.env.WORKER_DB_PATH = ':memory:';
    process.env.LOGS_DB_PATH = ':memory:';
    process.env.MEMORY_PROVIDER = 'mem0';
    process.env.MEM0_BASE_URL = 'http://mem0.local';
    process.env.MEM0_API_PATH = '/v1';
    process.env.WHATSAPP_BRIDGE_URL = 'http://bridge.local';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === 'string' ? input : input.toString();
        const pathname = new URL(url).pathname;
        if (
          String(init?.method || 'GET').toUpperCase() === 'POST' &&
          pathname.endsWith('/v2/memories')
        ) {
          return new Response(JSON.stringify({ memories: [], total: 0, page: 1, page_size: 25 }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }) as unknown as typeof fetch,
    );
    vi.doMock('../../../src/server/security/status', () => ({
      buildSecurityStatusSnapshot: (): SecuritySnapshot => ({
        checks: [],
        summary: { ok: 1, warning: 0, critical: 0 },
      }),
    }));

    const { getCredentialStore } = await import('../../../src/server/channels/credentials');
    getCredentialStore().setCredential('whatsapp', 'pairing_status', 'connected');

    const { runHealthCommand } = await import('../../../src/commands/healthCommand');
    const report = await runHealthCommand({
      fetchImpl: vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: false }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    });

    const bridgeCheck = report.checks.find((c) => c.id === 'integration.whatsapp_bridge');
    expect(bridgeCheck?.status).toBe('warning');
    expect(report.status).toBe('degraded');
  });

  it('skips optional bridge checks when bridge URL exists but channel is not paired', async () => {
    process.env.WHATSAPP_BRIDGE_URL = 'http://bridge.local';

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const { runHealthCommand } = await import('../../../src/commands/healthCommand');
    const report = await runHealthCommand({ fetchImpl: fetchMock });

    const bridgeCheck = report.checks.find((c) => c.id === 'integration.whatsapp_bridge');
    expect(bridgeCheck?.status).toBe('skipped');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('marks report as critical when security snapshot contains critical findings', async () => {
    vi.doMock('../../../src/server/security/status', () => ({
      buildSecurityStatusSnapshot: (): SecuritySnapshot => ({
        checks: [{ id: 'firewall', status: 'critical', detail: 'high-risk enabled' }],
        summary: { ok: 0, warning: 0, critical: 1 },
      }),
    }));

    const { runHealthCommand } = await import('../../../src/commands/healthCommand');
    const report = await runHealthCommand();

    expect(report.checks.find((c) => c.id === 'security.snapshot')?.status).toBe('critical');
    expect(report.status).toBe('critical');
  });

  it('marks report as critical when a configured bridge check times out', async () => {
    process.env.MESSAGES_DB_PATH = ':memory:';
    process.env.WHATSAPP_BRIDGE_URL = 'http://bridge.local';
    const { getCredentialStore } = await import('../../../src/server/channels/credentials');
    getCredentialStore().setCredential('whatsapp', 'pairing_status', 'connected');
    const timeoutError = new Error('operation timed out') as Error & { name: string };
    timeoutError.name = 'AbortError';

    const { runHealthCommand } = await import('../../../src/commands/healthCommand');
    const report = await runHealthCommand({
      fetchImpl: vi.fn().mockRejectedValue(timeoutError),
      timeoutMs: 25,
    });

    const bridgeCheck = report.checks.find((c) => c.id === 'integration.whatsapp_bridge');
    expect(bridgeCheck?.status).toBe('critical');
    expect(report.status).toBe('critical');
  });

  it('includes diagnostics checks for error budget, backlog, memory pressure and alert routing', async () => {
    process.env.MESSAGES_DB_PATH = ':memory:';
    process.env.WORKER_DB_PATH = ':memory:';

    const { LogRepository } = await import('../../../src/logging/logRepository');
    const { getWorkerRepository } = await import('../../../src/server/worker/workerRepository');
    const repo = new LogRepository(':memory:');
    globalThis.__logRepository = repo;

    for (let i = 0; i < 30; i += 1) {
      repo.insertLog('info', 'SYS', `info-${i}`, { i }, 'system');
    }
    for (let i = 0; i < 2; i += 1) {
      repo.insertLog('error', 'SYS', `error-${i}`, { i }, 'system');
    }

    const workerRepo = getWorkerRepository();
    for (let i = 0; i < 21; i += 1) {
      workerRepo.createTask({
        title: `Task ${i}`,
        objective: 'health diagnostics backlog test',
        originPlatform: 'WebChat' as never,
        originConversation: `conv-${i}`,
      });
    }

    const { runHealthCommand } = await import('../../../src/commands/healthCommand');
    const report = await runHealthCommand();

    expect(report.checks.some((c) => c.id === 'diagnostics.error_budget')).toBe(true);
    expect(report.checks.some((c) => c.id === 'diagnostics.task_backlog')).toBe(true);
    expect(report.checks.some((c) => c.id === 'diagnostics.memory_pressure')).toBe(true);
    expect(report.checks.find((c) => c.id === 'diagnostics.alert_routing')?.status).toBe('skipped');
  });

  it('captures detailed memory diagnostics and persists a memory sample log when enabled', async () => {
    process.env.MESSAGES_DB_PATH = ':memory:';
    process.env.LOGS_DB_PATH = ':memory:';

    const { LogRepository } = await import('../../../src/logging/logRepository');
    const repo = new LogRepository(':memory:');
    globalThis.__logRepository = repo;

    const { runHealthCommand } = await import('../../../src/commands/healthCommand');
    const report = await runHealthCommand({ memoryDiagnosticsEnabled: true });
    const memoryCheck = report.checks.find((c) => c.id === 'diagnostics.memory_pressure');

    expect(memoryCheck).toBeDefined();
    expect(memoryCheck?.details).toBeDefined();
    const details = (memoryCheck?.details ?? {}) as Record<string, unknown>;
    expect(typeof details.heapUsed).toBe('number');
    expect(typeof details.heapTotal).toBe('number');
    expect(details.currentProcess).toBeDefined();
    expect(details.nodeProcesses).toBeDefined();
    expect(details.memoryNodes).toBeDefined();

    const memLogs = repo.listLogs({ source: 'MEM', limit: 10 });
    expect(memLogs.some((entry) => entry.message.startsWith('memory.diagnostics.sample'))).toBe(
      true,
    );
  });

  it('skips expensive memory diagnostics and sample logging when disabled', async () => {
    process.env.MESSAGES_DB_PATH = ':memory:';
    process.env.LOGS_DB_PATH = ':memory:';

    const { LogRepository } = await import('../../../src/logging/logRepository');
    const repo = new LogRepository(':memory:');
    globalThis.__logRepository = repo;

    const { runHealthCommand } = await import('../../../src/commands/healthCommand');
    const report = await runHealthCommand({ memoryDiagnosticsEnabled: false });
    const memoryCheck = report.checks.find((c) => c.id === 'diagnostics.memory_pressure');

    expect(memoryCheck).toBeDefined();
    expect(memoryCheck?.details).toBeDefined();
    const details = (memoryCheck?.details ?? {}) as Record<string, unknown>;
    expect(typeof details.heapUsed).toBe('number');
    expect(typeof details.heapTotal).toBe('number');
    expect(details.currentProcess).toBeUndefined();
    expect(details.nodeProcesses).toBeUndefined();
    expect(details.memoryNodes).toBeUndefined();

    const memLogs = repo.listLogs({ source: 'MEM', limit: 10 });
    expect(memLogs.some((entry) => entry.message.startsWith('memory.diagnostics.sample'))).toBe(
      false,
    );
  });
});
