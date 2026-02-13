import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LogRepository } from '../../../src/logging/logRepository';

function mockUserContext(context: { userId: string; authenticated: boolean } | null): void {
  vi.doMock('../../../src/server/auth/userContext', () => ({
    resolveRequestUserContext: vi.fn().mockResolvedValue(context),
  }));
}

describe('POST /api/logs/ingest', () => {
  let repo: LogRepository;

  beforeEach(() => {
    repo = new LogRepository(':memory:');
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
    const { POST } = await import('../../../app/api/logs/ingest/route');
    const response = await POST(
      new Request('http://localhost/api/logs/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'SYS', message: 'hello' }),
      }),
    );
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

    const { POST } = await import('../../../app/api/logs/ingest/route');
    const response = await POST(
      new Request('http://localhost/api/logs/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'SYS', message: 'hello' }),
      }),
    );
    const data = (await response.json()) as { ok: boolean; error: string };

    expect(response.status).toBe(401);
    expect(data.ok).toBe(false);
    expect(data.error).toContain('Unauthorized');
  });

  it('accepts ingest and persists entry for authenticated or legacy-local context', async () => {
    mockUserContext({ userId: 'legacy-local-user', authenticated: false });
    const { POST } = await import('../../../app/api/logs/ingest/route');
    const response = await POST(
      new Request('http://localhost/api/logs/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'AUTH', message: 'Token expired' }),
      }),
    );
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.entry.category).toBe('security');
    expect(repo.listLogs()).toHaveLength(1);
  });
});
