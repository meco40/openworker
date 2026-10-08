import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const getTokenMock = vi.fn();

vi.mock('next-auth/jwt', () => ({
  getToken: getTokenMock,
}));

// What server.ts does for a loopback socket peer. LAN peers never get the marker.
const LOOPBACK_SOCKET = { 'x-openclaw-client-loopback': '1' } as const;
const ORIGINAL_ENV = { ...process.env };

type EnvOverrides = Record<string, string | undefined>;

async function loadProxy(overrides: EnvOverrides = {}) {
  process.env = {
    ...ORIGINAL_ENV,
    NEXTAUTH_SECRET: 'test-secret',
    AUTH_SECRET: 'test-secret',
    DEMO_MODE: 'false',
    REQUIRE_AUTH: 'false',
    MC_API_TOKEN: undefined,
    ...overrides,
  } as NodeJS.ProcessEnv;
  const { proxy } = await import('../../../proxy');
  return proxy;
}

function apiRequest(
  headers: Record<string, string>,
  path = '/api/skills/execute',
  method = 'POST',
) {
  return new NextRequest(`http://localhost:3000${path}`, { method, headers });
}

describe('proxy request-origin matrix (server.ts marker + headers)', () => {
  beforeEach(() => {
    vi.resetModules();
    getTokenMock.mockReset().mockResolvedValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV };
  });

  it('refuses a LAN client that spoofs a same-origin Origin, with and without MC_API_TOKEN', async () => {
    const spoofed = { host: 'localhost:3000', origin: 'http://localhost:3000' };

    const noToken = await loadProxy();
    expect((await noToken(apiRequest(spoofed))).status).toBe(401);

    vi.resetModules();
    const withToken = await loadProxy({ MC_API_TOKEN: 'proxy-token' });
    expect((await withToken(apiRequest(spoofed))).status).toBe(401);
  });

  it('refuses CSRF from an evil origin aimed at a loopback socket', async () => {
    const proxy = await loadProxy();

    const response = await proxy(
      apiRequest({
        ...LOOPBACK_SOCKET,
        host: 'localhost:3000',
        origin: 'https://evil.example',
        'sec-fetch-site': 'cross-site',
        'content-type': 'text/plain',
      }),
    );

    expect(response.status).toBe(401);
  });

  it('refuses DNS rebinding where Host and Origin both name the attacker', async () => {
    const proxy = await loadProxy();

    const response = await proxy(
      apiRequest({
        ...LOOPBACK_SOCKET,
        host: 'evil.example:3000',
        origin: 'http://evil.example:3000',
        'sec-fetch-site': 'same-origin',
      }),
    );

    expect(response.status).toBe(401);
  });

  it('allows same-origin browser UI on loopback without a token', async () => {
    const proxy = await loadProxy();

    const response = await proxy(
      apiRequest({
        ...LOOPBACK_SOCKET,
        host: 'localhost:3000',
        origin: 'http://localhost:3000',
        'sec-fetch-site': 'same-origin',
      }),
    );

    expect(response.status).toBe(200);
  });

  it('allows a loopback curl without Origin when no token is configured', async () => {
    const proxy = await loadProxy();

    const response = await proxy(apiRequest({ ...LOOPBACK_SOCKET, host: '127.0.0.1:3000' }));

    expect(response.status).toBe(200);
  });

  it('refuses a loopback curl without Origin once MC_API_TOKEN is set, and accepts the bearer', async () => {
    const proxy = await loadProxy({ MC_API_TOKEN: 'proxy-token' });

    const anonymous = await proxy(apiRequest({ ...LOOPBACK_SOCKET, host: '127.0.0.1:3000' }));
    expect(anonymous.status).toBe(401);

    const bearer = await proxy(
      apiRequest({
        ...LOOPBACK_SOCKET,
        host: '127.0.0.1:3000',
        authorization: 'Bearer proxy-token',
      }),
    );
    expect(bearer.status).toBe(200);
  });

  it('allows same-origin browser UI on loopback when MC_API_TOKEN is set', async () => {
    const proxy = await loadProxy({ MC_API_TOKEN: 'proxy-token' });

    const response = await proxy(
      apiRequest({
        ...LOOPBACK_SOCKET,
        host: 'localhost:3000',
        referer: 'http://localhost:3000/chat',
      }),
    );

    expect(response.status).toBe(200);
  });

  it('refuses anonymous loopback access when REQUIRE_AUTH is true', async () => {
    const proxy = await loadProxy({ REQUIRE_AUTH: 'true' });

    const response = await proxy(
      apiRequest({
        ...LOOPBACK_SOCKET,
        host: 'localhost:3000',
        origin: 'http://localhost:3000',
        'sec-fetch-site': 'same-origin',
      }),
    );

    expect(response.status).toBe(401);
  });

  it('still honors a NextAuth session without the loopback marker', async () => {
    const proxy = await loadProxy({ REQUIRE_AUTH: 'true' });
    getTokenMock.mockResolvedValueOnce({ sub: 'user-1' });

    const response = await proxy(apiRequest({ host: 'mc.example.com' }));

    expect(response.status).toBe(200);
  });
});
