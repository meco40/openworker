import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetCredential = vi.fn();
const mockSnapshot = vi.fn();
const mockListLogs = vi.fn();
const mockExecFile = vi.fn();

vi.mock('@/server/channels/credentials', () => ({
  getCredentialStore: () => ({
    getCredential: mockGetCredential,
  }),
}));

vi.mock('@/server/memory/runtime', () => ({
  getMemoryService: () => ({
    snapshot: mockSnapshot,
  }),
}));

vi.mock('@/logging/logRepository', () => ({
  getLogRepository: () => ({
    listLogs: mockListLogs,
  }),
}));

vi.mock('node:child_process', () => ({
  execFile: mockExecFile,
}));

describe('health check helper branch coverage', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-22T10:00:00.000Z'));
    mockGetCredential.mockReset();
    mockSnapshot.mockReset();
    mockListLogs.mockReset();
    mockExecFile.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete process.env.WHATSAPP_BRIDGE_URL;
    delete process.env.IMESSAGE_BRIDGE_URL;
  });

  it('counts recent non-diagnostic log entries and errors', async () => {
    mockListLogs.mockReturnValue([
      {
        category: 'diagnostics',
        source: 'MEM',
        message: 'memory.diagnostics.sample.one',
        createdAt: '2026-04-22T09:59:00.000Z',
        timestamp: '2026-04-22T09:59:00.000Z',
        level: 'error',
      },
      {
        category: 'runtime',
        source: 'APP',
        message: 'kept',
        createdAt: '2026-04-22T09:58:00.000Z',
        timestamp: '2026-04-22T09:58:00.000Z',
        level: 'error',
      },
      {
        category: 'runtime',
        source: 'APP',
        message: 'old',
        createdAt: '2026-04-22T09:00:00.000Z',
        timestamp: '2026-04-22T09:00:00.000Z',
        level: 'info',
      },
      {
        category: 'runtime',
        source: 'APP',
        message: 'bad-ts',
        createdAt: '',
        timestamp: 'invalid',
        level: 'error',
      },
    ]);

    const mod = await import('@/commands/health/checkHelpers');
    expect(mod.resolveRecentLogWindowStats()).toEqual({
      total: 1,
      errors: 1,
      windowMinutes: 15,
    });
  });

  it('returns memory node diagnostics and falls back on snapshot failure', async () => {
    mockSnapshot.mockResolvedValueOnce([
      {
        id: 'n1',
        type: 'fact',
        content: 'hello',
        embedding: [1, 2],
        metadata: { source: 'chat' },
      },
      {
        id: 'n2',
        type: 'fact',
        content: 'world!',
        embedding: [],
        metadata: {},
      },
      {
        id: 'n3',
        type: 'summary',
        content: 'sum',
        embedding: [3],
        metadata: { a: 1, b: true },
      },
    ]);
    mockSnapshot.mockRejectedValueOnce(new Error('snapshot failed'));

    const mod = await import('@/commands/health/checkHelpers');
    const ok = await mod.resolveMemoryNodeDiagnostics(2);
    expect(ok.summary.totalNodes).toBe(3);
    expect(ok.byType[0]?.type).toBe('fact');
    expect(ok.largestNodes).toHaveLength(2);

    const fallback = await mod.resolveMemoryNodeDiagnostics();
    expect(fallback.summary.totalNodes).toBe(0);
    expect(fallback.collectionError).toBe('snapshot failed');
  });

  it('handles bridge checks across skip, success, warning, timeout, and error branches', async () => {
    const mod = await import('@/commands/health/checkHelpers');

    const missing = await mod.runBridgeHealthCheck('bridge', 'whatsapp', 'WHATSAPP_BRIDGE_URL', {});
    expect(missing.status).toBe('skipped');

    process.env.WHATSAPP_BRIDGE_URL = 'http://bridge.local';
    mockGetCredential.mockReturnValueOnce('disconnected');
    const unpaired = await mod.runBridgeHealthCheck(
      'bridge',
      'whatsapp',
      'WHATSAPP_BRIDGE_URL',
      {},
    );
    expect(unpaired.status).toBe('skipped');
    expect(unpaired.details).toMatchObject({ paired: false });

    mockGetCredential.mockReturnValue('connected');
    const okFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockRejectedValue(new Error('bad json')),
    });
    const ok = await mod.runBridgeHealthCheck('bridge', 'whatsapp', 'WHATSAPP_BRIDGE_URL', {
      fetchImpl: okFetch,
      timeoutMs: 50,
    });
    expect(ok.status).toBe('ok');

    const warningFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
    });
    const warning = await mod.runBridgeHealthCheck('bridge', 'whatsapp', 'WHATSAPP_BRIDGE_URL', {
      fetchImpl: warningFetch,
    });
    expect(warning.status).toBe('warning');
    expect(warning.message).toContain('503');

    const timeoutFetch = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('timed out'), { name: 'AbortError' }));
    const timeout = await mod.runBridgeHealthCheck('bridge', 'whatsapp', 'WHATSAPP_BRIDGE_URL', {
      fetchImpl: timeoutFetch,
      timeoutMs: 1,
    });
    expect(timeout.status).toBe('critical');

    const genericFetch = vi.fn().mockRejectedValue(new Error('bridge offline'));
    const generic = await mod.runBridgeHealthCheck('bridge', 'whatsapp', 'WHATSAPP_BRIDGE_URL', {
      fetchImpl: genericFetch,
    });
    expect(generic.status).toBe('warning');
    expect(generic.details).toMatchObject({ bridgeUrl: 'http://bridge.local', timeoutMs: 3000 });
  });
});
