import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const getTokenMock = vi.fn();

vi.mock('next-auth/jwt', () => ({
  getToken: getTokenMock,
}));

describe('proxy middleware branches', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    getTokenMock.mockReset().mockResolvedValue(null);
    process.env = {
      ...originalEnv,
      NEXTAUTH_SECRET: 'test-secret',
      AUTH_SECRET: 'test-secret',
      MC_API_TOKEN: 'proxy-token',
      REQUIRE_AUTH: 'false',
      DEMO_MODE: 'false',
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  it('adds a demo header on non-api routes and blocks mutating demo-mode api requests', async () => {
    process.env.DEMO_MODE = 'true';
    const { proxy } = await import('../../../proxy');

    const pageResponse = await proxy(new NextRequest('http://localhost/dashboard'));
    expect(pageResponse.headers.get('X-Demo-Mode')).toBe('true');

    const blocked = await proxy(
      new NextRequest('http://localhost/api/private', {
        method: 'POST',
      }),
    );
    expect(blocked.status).toBe(403);

    const allowedRead = await proxy(
      new NextRequest('http://localhost/api/private', {
        method: 'GET',
      }),
    );
    expect(allowedRead.status).toBe(200);
  });

  it('allows public api paths, authenticated sessions, and same-origin browser requests', async () => {
    const { proxy } = await import('../../../proxy');

    const publicResponse = await proxy(
      new NextRequest('http://localhost/api/channels/telegram/webhook'),
    );
    expect(publicResponse.status).toBe(200);

    getTokenMock.mockResolvedValueOnce({ sub: 'user-1' });
    const sessionResponse = await proxy(new NextRequest('http://localhost/api/private'));
    expect(sessionResponse.status).toBe(200);

    getTokenMock.mockRejectedValueOnce(new Error('token failure'));
    const sameOriginResponse = await proxy(
      new NextRequest('http://localhost/api/private', {
        headers: {
          host: 'localhost',
          origin: 'http://localhost',
        },
      }),
    );
    expect(sameOriginResponse.status).toBe(200);
    expect(getTokenMock).toHaveBeenCalledTimes(1);
  });

  it('handles missing tokens, events stream query tokens, and bearer validation', async () => {
    const { proxy } = await import('../../../proxy');

    const unauthorized = await proxy(
      new NextRequest('http://example.com/api/private', {
        headers: {
          host: 'example.com',
          origin: 'https://evil.example',
        },
      }),
    );
    expect(unauthorized.status).toBe(401);

    const sseAllowed = await proxy(
      new NextRequest('http://localhost/api/events/stream?token=proxy-token'),
    );
    expect(sseAllowed.status).toBe(200);

    const sseDenied = await proxy(
      new NextRequest('http://localhost/api/events/stream?token=wrong-token'),
    );
    expect(sseDenied.status).toBe(401);

    const badBearer = await proxy(
      new NextRequest('http://localhost/api/private', {
        headers: {
          authorization: 'Bearer wrong-token',
        },
      }),
    );
    expect(badBearer.status).toBe(401);

    const goodBearer = await proxy(
      new NextRequest('http://localhost/api/private', {
        headers: {
          authorization: 'Bearer proxy-token',
        },
      }),
    );
    expect(goodBearer.status).toBe(200);
  });

  it('uses the no-token policy path when MC_API_TOKEN is unset', async () => {
    delete process.env.MC_API_TOKEN;
    const { proxy } = await import('../../../proxy');

    const denied = await proxy(
      new NextRequest('http://example.com/api/private', {
        headers: {
          host: 'example.com',
        },
      }),
    );
    expect(denied.status).toBe(401);

    const allowed = await proxy(
      new NextRequest('http://localhost/api/private', {
        headers: {
          host: 'localhost',
          referer: 'http://localhost/page',
        },
      }),
    );
    expect(allowed.status).toBe(200);
  });
});
