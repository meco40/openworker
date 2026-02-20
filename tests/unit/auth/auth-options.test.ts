import { afterEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

describe('auth options secret resolution', () => {
  it('uses NEXTAUTH_SECRET when configured', async () => {
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: 'test',
      NEXTAUTH_SECRET: 'nextauth-secret',
      AUTH_SECRET: 'auth-secret',
    };
    vi.resetModules();

    const { authOptions } = await import('@/auth');

    expect(authOptions.secret).toBe('nextauth-secret');
  });

  it('falls back to AUTH_SECRET when NEXTAUTH_SECRET is not set', async () => {
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: 'test',
      AUTH_SECRET: 'auth-secret-only',
    };
    delete process.env.NEXTAUTH_SECRET;
    vi.resetModules();

    const { authOptions } = await import('@/auth');

    expect(authOptions.secret).toBe('auth-secret-only');
  });

  it('uses a deterministic local secret outside production when no env secret exists', async () => {
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: 'test',
    };
    delete process.env.NEXTAUTH_SECRET;
    delete process.env.AUTH_SECRET;
    vi.resetModules();

    const { authOptions } = await import('@/auth');

    expect(typeof authOptions.secret).toBe('string');
    expect(authOptions.secret).toBe('openclaw-local-nextauth-secret');
  });

  it('keeps a deterministic fallback secret in production when no env secret exists', async () => {
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: 'production',
    };
    delete process.env.NEXTAUTH_SECRET;
    delete process.env.AUTH_SECRET;
    vi.resetModules();

    const { authOptions } = await import('@/auth');

    expect(authOptions.secret).toBe('openclaw-local-nextauth-secret');
  });
});
