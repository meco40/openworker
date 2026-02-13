import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LEGACY_LOCAL_USER_ID,
  resolveUserIdFromSession,
} from '../../../src/server/auth/userContext';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('resolveUserIdFromSession', () => {
  it('returns the authenticated user id when present', () => {
    const resolved = resolveUserIdFromSession(
      {
        user: {
          id: 'user-123',
          email: 'user@example.com',
          name: 'User',
        },
      },
      false,
    );

    expect(resolved).toBe('user-123');
  });

  it('falls back to legacy local user when auth is not required', () => {
    const resolved = resolveUserIdFromSession(null, false);
    expect(resolved).toBe(LEGACY_LOCAL_USER_ID);
  });

  it('returns null when auth is required and no session exists', () => {
    const resolved = resolveUserIdFromSession(null, true);
    expect(resolved).toBeNull();
  });
});

describe('resolveRequestUserContext', () => {
  it('falls back to legacy local user when auth context is unavailable and auth is optional', async () => {
    process.env = { ...ORIGINAL_ENV, REQUIRE_AUTH: 'false' };
    vi.doMock('../../../src/auth', () => ({
      auth: vi
        .fn()
        .mockRejectedValue(
          new Error(
            '`headers` was called outside a request scope. Read more: https://nextjs.org/docs/messages/next-dynamic-api-wrong-context',
          ),
        ),
    }));

    const { resolveRequestUserContext } = await import('../../../src/server/auth/userContext');
    const context = await resolveRequestUserContext();

    expect(context).toEqual({
      userId: LEGACY_LOCAL_USER_ID,
      authenticated: false,
    });
  });

  it('returns null when auth is required and auth context is unavailable', async () => {
    process.env = { ...ORIGINAL_ENV, REQUIRE_AUTH: 'true' };
    vi.doMock('../../../src/auth', () => ({
      auth: vi
        .fn()
        .mockRejectedValue(
          new Error(
            '`headers` was called outside a request scope. Read more: https://nextjs.org/docs/messages/next-dynamic-api-wrong-context',
          ),
        ),
    }));

    const { resolveRequestUserContext } = await import('../../../src/server/auth/userContext');
    const context = await resolveRequestUserContext();

    expect(context).toBeNull();
  });

  it('rethrows unexpected auth errors', async () => {
    process.env = { ...ORIGINAL_ENV, REQUIRE_AUTH: 'false' };
    vi.doMock('../../../src/auth', () => ({
      auth: vi.fn().mockRejectedValue(new Error('Database unavailable')),
    }));

    const { resolveRequestUserContext } = await import('../../../src/server/auth/userContext');

    await expect(resolveRequestUserContext()).rejects.toThrow('Database unavailable');
  });
});
