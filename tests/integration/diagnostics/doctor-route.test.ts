import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  delete process.env.REQUIRE_AUTH;
});

describe('GET /api/doctor', () => {
  it('returns 401 when user context is unavailable', async () => {
    vi.doMock('../../../src/server/auth/userContext', () => ({
      resolveRequestUserContext: vi.fn().mockResolvedValue(null),
    }));

    const { GET } = await import('../../../app/api/doctor/route');
    const response = await GET(new Request('http://localhost/api/doctor'));
    const payload = (await response.json()) as { ok: boolean; error: string };

    expect(response.status).toBe(401);
    expect(payload.ok).toBe(false);
    expect(payload.error).toContain('Unauthorized');
  });

  it('returns doctor report for authenticated or legacy-local context', async () => {
    const runDoctorCommand = vi.fn().mockResolvedValue({
      status: 'degraded',
      checks: [],
      findings: [
        {
          id: 'bridge_unreachable',
          severity: 'warning',
          title: 'Bridge Health Degraded',
          detail: 'Bridge health failed with 503.',
          recommendation: 'Verify bridge.',
        },
      ],
      recommendations: ['Verify bridge.'],
      generatedAt: '2026-02-11T00:00:00.000Z',
    });
    vi.doMock('../../../src/server/auth/userContext', () => ({
      resolveRequestUserContext: vi.fn().mockResolvedValue({
        userId: 'legacy-local-user',
        authenticated: false,
      }),
    }));
    vi.doMock('../../../src/commands/doctorCommand', () => ({
      runDoctorCommand,
    }));

    const { GET } = await import('../../../app/api/doctor/route');
    const response = await GET(new Request('http://localhost/api/doctor?memoryDiagnostics=true'));
    const payload = (await response.json()) as { ok: boolean; status: string; findings: unknown[] };

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.status).toBe('degraded');
    expect(payload.findings).toHaveLength(1);
    expect(runDoctorCommand).toHaveBeenCalledWith({ memoryDiagnosticsEnabled: true });
  });

  it('returns 401 when REQUIRE_AUTH is true and no session exists', async () => {
    process.env.REQUIRE_AUTH = 'true';
    vi.doUnmock('../../../src/server/auth/userContext');
    vi.doUnmock('../../../src/commands/doctorCommand');
    vi.doMock('../../../src/auth', () => ({
      auth: vi.fn().mockResolvedValue(null),
    }));

    const { GET } = await import('../../../app/api/doctor/route');
    const response = await GET(new Request('http://localhost/api/doctor'));
    const payload = (await response.json()) as { ok: boolean; error: string };

    expect(response.status).toBe(401);
    expect(payload.ok).toBe(false);
    expect(payload.error).toContain('Unauthorized');
  });
});
