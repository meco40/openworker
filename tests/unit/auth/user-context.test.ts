import { describe, expect, it } from 'vitest';
import { LEGACY_LOCAL_USER_ID, resolveUserIdFromSession } from '../../../src/server/auth/userContext';

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
