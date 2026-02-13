import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function mockUserContext(context: { userId: string; authenticated: boolean } | null): void {
  vi.doMock('../../../src/server/auth/userContext', () => ({
    resolveRequestUserContext: vi.fn().mockResolvedValue(context),
  }));
}

function makePutRequest(body: unknown): Request {
  return new Request('http://localhost/api/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('config conflict payload contract', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('returns deterministic conflict payload for stale save', async () => {
    mockUserContext({ userId: 'legacy-local-user', authenticated: false });
    const route = await import('../../../app/api/config/route');

    const getResponse = await route.GET();
    const getPayload = (await getResponse.json()) as { revision: string };

    const conflictResponse = await route.PUT(
      makePutRequest({
        config: { gateway: { port: 8090, host: '127.0.0.1', logLevel: 'info' } },
        revision: `${getPayload.revision}-old`,
      }),
    );

    const conflictPayload = (await conflictResponse.json()) as {
      ok: boolean;
      code?: string;
      error?: string;
      currentRevision?: string;
    };

    expect(conflictResponse.status).toBe(409);
    expect(conflictPayload.ok).toBe(false);
    expect(conflictPayload.code).toBe('CONFIG_STALE_REVISION');
    expect(conflictPayload.error).toContain('changed by another session');
    expect(typeof conflictPayload.currentRevision).toBe('string');
  });
});
