import { describe, expect, it } from 'vitest';
import { shouldAllowApiRequestWithoutToken } from '@/server/auth/proxyPolicy';

describe('shouldAllowApiRequestWithoutToken', () => {
  it('allows authenticated requests when no API token is configured', () => {
    const allowed = shouldAllowApiRequestWithoutToken({
      requireAuth: true,
      hasSession: true,
      sameOrigin: false,
      loopbackHost: false,
    });

    expect(allowed).toBe(true);
  });

  it('denies unauthenticated requests when auth is required', () => {
    const allowed = shouldAllowApiRequestWithoutToken({
      requireAuth: true,
      hasSession: false,
      sameOrigin: true,
      loopbackHost: true,
    });

    expect(allowed).toBe(false);
  });

  it('allows same-origin browser requests when auth is optional', () => {
    const allowed = shouldAllowApiRequestWithoutToken({
      requireAuth: false,
      hasSession: false,
      sameOrigin: true,
      loopbackHost: false,
    });

    expect(allowed).toBe(true);
  });

  it('denies external anonymous requests when auth is optional', () => {
    const allowed = shouldAllowApiRequestWithoutToken({
      requireAuth: false,
      hasSession: false,
      sameOrigin: false,
      loopbackHost: false,
    });

    expect(allowed).toBe(false);
  });
});
