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

describe('config revision concurrency', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('returns revision on GET and rejects stale PUT', async () => {
    mockUserContext({ userId: 'legacy-local-user', authenticated: false });
    const route = await import('../../../app/api/config/route');

    const getResponse = await route.GET();
    const getPayload = (await getResponse.json()) as { ok: boolean; revision: string };

    expect(getResponse.status).toBe(200);
    expect(getPayload.ok).toBe(true);
    expect(typeof getPayload.revision).toBe('string');

    const putResponse = await route.PUT(
      makePutRequest({
        revision: `${getPayload.revision}-stale`,
        config: { gateway: { port: 8080, host: '127.0.0.1', logLevel: 'info' } },
      }),
    );
    const putPayload = (await putResponse.json()) as {
      ok: boolean;
      code?: string;
      currentRevision?: string;
    };

    expect(putResponse.status).toBe(409);
    expect(putPayload.ok).toBe(false);
    expect(putPayload.code).toBe('CONFIG_STALE_REVISION');
    expect(typeof putPayload.currentRevision).toBe('string');
  });
});
