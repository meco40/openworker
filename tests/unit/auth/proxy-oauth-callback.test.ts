import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('next-auth/jwt', () => ({
  getToken: vi.fn(async () => null),
}));

describe('proxy oauth callback handling', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env = {
      ...originalEnv,
      MC_API_TOKEN: 'test-token',
      REQUIRE_AUTH: 'false',
      NEXTAUTH_SECRET: 'test-secret',
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  it('keeps model-hub oauth callback reachable without bearer token', async () => {
    const { proxy } = await import('../../../proxy');
    const request = new NextRequest(
      'http://localhost:3000/api/model-hub/oauth/callback?code=abc&state=xyz',
      {
        method: 'GET',
      },
    );

    const response = await proxy(request);

    expect(response.status).not.toBe(401);
  });
});
