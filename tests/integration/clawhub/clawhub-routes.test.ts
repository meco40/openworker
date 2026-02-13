import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClawHubNotFoundError } from '../../../src/server/clawhub/errors';

function mockUserContext(context: { userId: string; authenticated: boolean } | null): void {
  vi.doMock('../../../src/server/auth/userContext', () => ({
    resolveRequestUserContext: vi.fn().mockResolvedValue(context),
  }));
}

function mockClawHubService(overrides?: {
  search?: () => Promise<unknown>;
  syncInstalledFromLockfile?: () => Promise<unknown>;
  install?: (payload: Record<string, unknown>) => Promise<unknown>;
  update?: (payload: Record<string, unknown>) => Promise<unknown>;
  uninstall?: (slug: string) => Promise<unknown>;
  explore?: () => Promise<unknown>;
  setEnabled?: (slug: string, enabled: boolean) => Promise<unknown>;
  getPromptBlock?: () => Promise<string>;
}) {
  vi.doMock('../../../src/server/clawhub/clawhubService', () => ({
    getClawHubService: () => ({
      search:
        overrides?.search ??
        (async () => ({ items: [{ slug: 'calendar', version: '1.0.0', title: 'Calendar', score: 0.5 }], parseWarnings: [] })),
      syncInstalledFromLockfile:
        overrides?.syncInstalledFromLockfile ??
        (async () => [{ slug: 'calendar', version: '1.0.0', status: 'installed', title: 'Calendar', localPath: 'skills/calendar' }]),
      install:
        overrides?.install ??
        (async () => ({ skills: [{ slug: 'calendar', version: '1.0.0' }], warnings: [] })),
      update:
        overrides?.update ??
        (async () => ({ skills: [{ slug: 'calendar', version: '1.0.1' }], warnings: [] })),
      uninstall:
        overrides?.uninstall ??
        (async () => ({ skills: [], warnings: [] })),
      explore:
        overrides?.explore ??
        (async () => ({ items: [{ slug: 'calendar', latestVersion: '1.0.0', title: 'Calendar' }] })),
      setEnabled:
        overrides?.setEnabled ??
        (async (slug: string, enabled: boolean) => ({
          slug,
          enabled,
          version: '1.0.0',
          title: 'Calendar',
          status: 'installed',
          localPath: 'skills/calendar',
        })),
      getPromptBlock: overrides?.getPromptBlock ?? (async () => 'PROMPT BLOCK'),
    }),
  }));
}

describe('clawhub routes', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('returns 401 on search when unauthorized', async () => {
    mockUserContext(null);
    mockClawHubService();

    const { GET } = await import('../../../app/api/clawhub/search/route');
    const response = await GET(new Request('http://localhost/api/clawhub/search?q=calendar'));
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.ok).toBe(false);
  });

  it('returns installed skills when authorized', async () => {
    mockUserContext({ userId: 'legacy-local-user', authenticated: false });
    mockClawHubService();

    const { GET } = await import('../../../app/api/clawhub/installed/route');
    const response = await GET();
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.skills).toHaveLength(1);
  });

  it('validates install payload', async () => {
    mockUserContext({ userId: 'legacy-local-user', authenticated: false });
    mockClawHubService();

    const { POST } = await import('../../../app/api/clawhub/install/route');
    const response = await POST(
      new Request('http://localhost/api/clawhub/install', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug: '' }),
      }),
    );
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.ok).toBe(false);
  });

  it('returns 400 when install slug is invalid', async () => {
    mockUserContext({ userId: 'legacy-local-user', authenticated: false });
    mockClawHubService({
      install: async () => {
        throw new Error('Invalid ClawHub skill slug: ../calendar');
      },
    });

    const { POST } = await import('../../../app/api/clawhub/install/route');
    const response = await POST(
      new Request('http://localhost/api/clawhub/install', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug: '../calendar' }),
      }),
    );
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.ok).toBe(false);
  });

  it('validates update payload constraints', async () => {
    mockUserContext({ userId: 'legacy-local-user', authenticated: false });
    mockClawHubService();

    const { POST } = await import('../../../app/api/clawhub/update/route');
    const response = await POST(
      new Request('http://localhost/api/clawhub/update', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ all: false }),
      }),
    );
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.ok).toBe(false);
  });

  it('returns 400 when update slug is invalid', async () => {
    mockUserContext({ userId: 'legacy-local-user', authenticated: false });
    mockClawHubService({
      update: async () => {
        throw new Error('Invalid ClawHub skill slug: calendar/../../bad');
      },
    });

    const { POST } = await import('../../../app/api/clawhub/update/route');
    const response = await POST(
      new Request('http://localhost/api/clawhub/update', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug: 'calendar/../../bad' }),
      }),
    );
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.ok).toBe(false);
  });

  it('toggles enabled flag on skill route', async () => {
    mockUserContext({ userId: 'legacy-local-user', authenticated: false });
    mockClawHubService();

    const { PATCH } = await import('../../../app/api/clawhub/[slug]/route');
    const response = await PATCH(
      new Request('http://localhost/api/clawhub/calendar', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      }),
      { params: Promise.resolve({ slug: 'calendar' }) },
    );
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.skill.enabled).toBe(true);
  });

  it('returns prompt block for authorized callers', async () => {
    mockUserContext({ userId: 'legacy-local-user', authenticated: false });
    mockClawHubService({ getPromptBlock: async () => 'PROMPT BLOCK' });

    const { GET } = await import('../../../app/api/clawhub/prompt/route');
    const response = await GET();
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.prompt).toBe('PROMPT BLOCK');
  });

  it('uninstalls skill on delete route', async () => {
    mockUserContext({ userId: 'legacy-local-user', authenticated: false });
    mockClawHubService();

    const { DELETE } = await import('../../../app/api/clawhub/[slug]/route');
    const response = await DELETE(
      new Request('http://localhost/api/clawhub/calendar', {
        method: 'DELETE',
      }),
      { params: Promise.resolve({ slug: 'calendar' }) },
    );
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.skills).toEqual([]);
  });

  it('maps typed not-found error on delete route to 404', async () => {
    mockUserContext({ userId: 'legacy-local-user', authenticated: false });
    mockClawHubService({
      uninstall: async () => {
        throw new ClawHubNotFoundError('ClawHub skill not found: calendar');
      },
    });

    const { DELETE } = await import('../../../app/api/clawhub/[slug]/route');
    const response = await DELETE(
      new Request('http://localhost/api/clawhub/calendar', {
        method: 'DELETE',
      }),
      { params: Promise.resolve({ slug: 'calendar' }) },
    );
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.ok).toBe(false);
  });
});
