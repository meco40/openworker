import { afterEach, describe, expect, it } from 'vitest';
import { assertProductionAuthConfig } from '@/server/auth/productionGuard';

const env = process.env as Record<string, string | undefined>;

describe('assertProductionAuthConfig', () => {
  const originalNodeEnv = env.NODE_ENV;
  const originalRequireAuth = env.REQUIRE_AUTH;
  const originalSecret = env.NEXTAUTH_SECRET;
  const originalAuthSecret = env.AUTH_SECRET;
  const originalE2eAnonymousAuth = env.E2E_ALLOW_ANONYMOUS_AUTH;
  const originalHostname = env.HOSTNAME;

  afterEach(() => {
    if (originalNodeEnv === undefined) {
      delete env.NODE_ENV;
    } else {
      env.NODE_ENV = originalNodeEnv;
    }
    if (originalRequireAuth === undefined) {
      delete env.REQUIRE_AUTH;
    } else {
      env.REQUIRE_AUTH = originalRequireAuth;
    }
    if (originalSecret === undefined) {
      delete env.NEXTAUTH_SECRET;
    } else {
      env.NEXTAUTH_SECRET = originalSecret;
    }
    if (originalAuthSecret === undefined) {
      delete env.AUTH_SECRET;
    } else {
      env.AUTH_SECRET = originalAuthSecret;
    }
    if (originalE2eAnonymousAuth === undefined) delete env.E2E_ALLOW_ANONYMOUS_AUTH;
    else env.E2E_ALLOW_ANONYMOUS_AUTH = originalE2eAnonymousAuth;
    if (originalHostname === undefined) delete env.HOSTNAME;
    else env.HOSTNAME = originalHostname;
  });

  it('returns early when not in production', () => {
    env.NODE_ENV = 'development';
    env.REQUIRE_AUTH = 'false';
    delete env.NEXTAUTH_SECRET;
    delete env.AUTH_SECRET;

    expect(() => assertProductionAuthConfig()).not.toThrow();
  });

  it('throws when REQUIRE_AUTH is not true in production', () => {
    env.NODE_ENV = 'production';
    env.REQUIRE_AUTH = 'false';
    env.NEXTAUTH_SECRET = 'secret';

    expect(() => assertProductionAuthConfig()).toThrow(
      'REQUIRE_AUTH must be set to "true" in production',
    );
  });

  it('throws when REQUIRE_AUTH is unset in production', () => {
    env.NODE_ENV = 'production';
    delete env.REQUIRE_AUTH;
    env.NEXTAUTH_SECRET = 'secret';

    expect(() => assertProductionAuthConfig()).toThrow(
      'REQUIRE_AUTH must be set to "true" in production',
    );
  });

  it('throws when NEXTAUTH_SECRET is missing in production', () => {
    env.NODE_ENV = 'production';
    env.REQUIRE_AUTH = 'true';
    delete env.NEXTAUTH_SECRET;
    delete env.AUTH_SECRET;

    expect(() => assertProductionAuthConfig()).toThrow(
      'NEXTAUTH_SECRET (or AUTH_SECRET) must be set in production',
    );
  });

  it('accepts AUTH_SECRET as alternative', () => {
    env.NODE_ENV = 'production';
    env.REQUIRE_AUTH = 'true';
    delete env.NEXTAUTH_SECRET;
    env.AUTH_SECRET = 'auth-secret';

    expect(() => assertProductionAuthConfig()).not.toThrow();
  });

  it('passes when REQUIRE_AUTH and NEXTAUTH_SECRET are set', () => {
    env.NODE_ENV = 'production';
    env.REQUIRE_AUTH = 'true';
    env.NEXTAUTH_SECRET = 'secret';

    expect(() => assertProductionAuthConfig()).not.toThrow();
  });

  it('allows anonymous auth only for an explicit loopback E2E process', () => {
    env.NODE_ENV = 'production';
    env.REQUIRE_AUTH = 'false';
    env.NEXTAUTH_SECRET = 'secret';
    env.HOSTNAME = '127.0.0.1';
    env.E2E_ALLOW_ANONYMOUS_AUTH = 'true';

    expect(() => assertProductionAuthConfig()).not.toThrow();

    env.HOSTNAME = '0.0.0.0';
    expect(() => assertProductionAuthConfig()).toThrow(
      'REQUIRE_AUTH must be set to "true" in production',
    );
  });
});
