import { describe, expect, it } from 'vitest';
import { LEGACY_LOCAL_USER_ID } from '@/server/auth/constants';

describe('auth constants', () => {
  it('exports the canonical legacy local user id', () => {
    expect(LEGACY_LOCAL_USER_ID).toBe('legacy-local-user');
  });
});
