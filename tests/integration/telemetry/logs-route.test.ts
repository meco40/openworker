import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LogRepository } from '@/logging/logRepository';

function mockUserContext(context: { userId: string; authenticated: boolean } | null): void {
  vi.doMock('../../../src/server/auth/userContext', () => ({
    resolveRequestUserContext: vi.fn().mockResolvedValue(context),
  }));
}

async function loadRoute() {
  return import('../../../app/api/logs/route');
}

describe('logs route access and filtering', () => {
  let repo: LogRepository;

  beforeEach(() => {
    repo = new LogRepository(':memory:');
    repo.insertLog('info', 'SYS', 'Gateway started', undefined, 'system');
    repo.insertLog('warn', 'BRIDGE', 'Latency spike', undefined, 'integration');
    repo.insertLog('error', 'AUTH', 'Token expired', undefined, 'security');
    globalThis.__logRepository = repo;
  });

  afterEach(() => {
    repo.close();
    globalThis.__logRepository = undefined;
    vi.restoreAllMocks();
    vi.resetModules();
    delete process.env.REQUIRE_AUTH;
  });

  it('returns 401 when user context is unavailable', async () => {
    mockUserContext(null);
    const { GET } = await loadRoute();
    const response = await GET(new Request('http://localhost/api/logs'));
    const data = (await response.json()) as { ok: boolean; error: string };

    expect(response.status).toBe(401);
    expect(data.ok).toBe(false);
    expect(data.error).toContain('Unauthorized');
  });

  it('returns 401 when REQUIRE_AUTH is true and no session exists', async () => {
    process.env.REQUIRE_AUTH = 'true';
    vi.doMock('../../../src/auth', () => ({
      auth: vi.fn().mockResolvedValue(null),
    }));

    const { GET } = await loadRoute();
    const response = await GET(new Request('http://localhost/api/logs'));
    const data = (await response.json()) as { ok: boolean; error: string };

    expect(response.status).toBe(401);
    expect(data.ok).toBe(false);
    expect(data.error).toContain('Unauthorized');
  });

  it('returns logs for authenticated or legacy-local context', async () => {
    mockUserContext({ userId: 'legacy-local-user', authenticated: false });
    const { GET } = await loadRoute();
    const response = await GET(new Request('http://localhost/api/logs'));
    const data = await response.json();

    expect(data.ok).toBe(true);
    expect(data.logs).toHaveLength(3);
    expect(data.total).toBe(3);
  });

  it('filters logs by category', async () => {
    mockUserContext({ userId: 'legacy-local-user', authenticated: false });
    const { GET } = await loadRoute();
    const response = await GET(new Request('http://localhost/api/logs?category=security'));
    const data = await response.json();

    expect(data.ok).toBe(true);
    expect(data.logs).toHaveLength(1);
    expect(data.logs[0].category).toBe('security');
  });

  it('returns filtered total when category filter is applied', async () => {
    mockUserContext({ userId: 'legacy-local-user', authenticated: false });
    const { GET } = await loadRoute();
    const response = await GET(new Request('http://localhost/api/logs?category=security'));
    const data = await response.json();

    expect(data.ok).toBe(true);
    expect(data.logs).toHaveLength(1);
    expect(data.total).toBe(1);
  });

  it('returns distinct categories list', async () => {
    mockUserContext({ userId: 'legacy-local-user', authenticated: false });
    const { GET } = await loadRoute();
    const response = await GET(new Request('http://localhost/api/logs?categories=1'));
    const data = await response.json();

    expect(data.ok).toBe(true);
    expect(data.categories).toEqual(['integration', 'security', 'system']);
  });

  it('clears logs for authenticated or legacy-local context', async () => {
    mockUserContext({ userId: 'legacy-local-user', authenticated: false });
    const { DELETE } = await loadRoute();
    const response = await DELETE();
    const data = await response.json();

    expect(data.ok).toBe(true);
    expect(data.deleted).toBe(3);
    expect(repo.listLogs()).toHaveLength(0);
  });
});
