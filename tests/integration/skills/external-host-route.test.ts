import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type MockUserContext = { userId: string; authenticated: boolean } | null;

const getExternalSkillHostStatusMock = vi.hoisted(() => vi.fn());
const stopExternalSkillHostMock = vi.hoisted(() => vi.fn());

function mockUserContext(context: MockUserContext): void {
  vi.doMock('@/server/auth/userContext', () => ({
    resolveRequestUserContext: vi.fn().mockResolvedValue(context),
  }));
}

vi.mock('@/server/skills/externalSkillHost', () => ({
  getExternalSkillHostStatus: getExternalSkillHostStatusMock,
  stopExternalSkillHost: stopExternalSkillHostMock,
}));

describe('/api/skills/external-host', () => {
  beforeEach(() => {
    vi.resetModules();
    getExternalSkillHostStatusMock.mockReset();
    stopExternalSkillHostMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('returns 401 when user context is missing', async () => {
    mockUserContext(null);

    const route = await import('../../../app/api/skills/external-host/route');
    const response = await route.GET();

    expect(response.status).toBe(401);
  });

  it('returns host status on GET', async () => {
    mockUserContext({ userId: 'legacy-local-user', authenticated: false });
    getExternalSkillHostStatusMock.mockReturnValue({
      running: true,
      pid: 12345,
      connected: true,
      pendingRequests: 1,
      timeoutMs: 30_000,
      idleMs: 60_000,
      startedAt: new Date('2026-02-27T05:10:00.000Z').toISOString(),
      totalRequests: 4,
    });

    const route = await import('../../../app/api/skills/external-host/route');
    const response = await route.GET();
    const json = (await response.json()) as {
      ok: boolean;
      status: { running: boolean; pid: number | null; totalRequests: number };
    };

    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.status.running).toBe(true);
    expect(json.status.pid).toBe(12345);
    expect(json.status.totalRequests).toBe(4);
  });

  it('stops host on POST action=stop', async () => {
    mockUserContext({ userId: 'legacy-local-user', authenticated: false });
    getExternalSkillHostStatusMock.mockReturnValue({
      running: false,
      pid: null,
      connected: false,
      pendingRequests: 0,
      timeoutMs: 30_000,
      idleMs: 60_000,
      startedAt: null,
      totalRequests: 5,
    });

    const route = await import('../../../app/api/skills/external-host/route');
    const response = await route.POST(
      new Request('http://localhost/api/skills/external-host', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'stop' }),
      }),
    );
    const json = (await response.json()) as { ok: boolean };

    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(stopExternalSkillHostMock).toHaveBeenCalledTimes(1);
  });
});
