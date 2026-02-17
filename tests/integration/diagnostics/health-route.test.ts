import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  delete process.env.REQUIRE_AUTH;
});

describe('GET /api/health', () => {
  it('returns 401 when user context is unavailable', async () => {
    vi.doMock('../../../src/server/auth/userContext', () => ({
      resolveRequestUserContext: vi.fn().mockResolvedValue(null),
    }));

    const { GET } = await import('../../../app/api/health/route');
    const response = await GET(new Request('http://localhost/api/health'));
    const payload = (await response.json()) as { ok: boolean; error: string };

    expect(response.status).toBe(401);
    expect(payload.ok).toBe(false);
    expect(payload.error).toContain('Unauthorized');
  });

  it('returns health report for authenticated or legacy-local context', async () => {
    const runHealthCommand = vi.fn().mockResolvedValue({
      status: 'ok',
      checks: [],
      summary: { ok: 1, warning: 0, critical: 0, skipped: 0 },
      generatedAt: '2026-02-11T00:00:00.000Z',
    });
    vi.doMock('../../../src/server/auth/userContext', () => ({
      resolveRequestUserContext: vi.fn().mockResolvedValue({
        userId: 'legacy-local-user',
        authenticated: false,
      }),
    }));
    vi.doMock('../../../src/commands/healthCommand', () => ({
      runHealthCommand,
    }));

    const { GET } = await import('../../../app/api/health/route');
    const response = await GET(new Request('http://localhost/api/health?memoryDiagnostics=1'));
    const payload = (await response.json()) as { ok: boolean; status: string };

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.status).toBe('ok');
    expect(runHealthCommand).toHaveBeenCalledWith({ memoryDiagnosticsEnabled: true });
  });

  it('returns 401 when REQUIRE_AUTH is true and no session exists', async () => {
    process.env.REQUIRE_AUTH = 'true';
    vi.doUnmock('../../../src/server/auth/userContext');
    vi.doUnmock('../../../src/commands/healthCommand');
    vi.doMock('../../../src/auth', () => ({
      auth: vi.fn().mockResolvedValue(null),
    }));

    const { GET } = await import('../../../app/api/health/route');
    const response = await GET(new Request('http://localhost/api/health'));
    const payload = (await response.json()) as { ok: boolean; error: string };

    expect(response.status).toBe(401);
    expect(payload.ok).toBe(false);
    expect(payload.error).toContain('Unauthorized');
  });
});
