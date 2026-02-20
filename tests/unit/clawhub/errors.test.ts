import { describe, expect, it } from 'vitest';

import {
  ClawHubInputError,
  ClawHubNotFoundError,
  isValidClawHubSlug,
  toClawHubHttpStatus,
} from '@/server/clawhub/errors';

describe('clawhub errors', () => {
  it('maps typed errors to stable HTTP status codes', () => {
    expect(toClawHubHttpStatus(new ClawHubInputError('bad slug'))).toBe(400);
    expect(toClawHubHttpStatus(new ClawHubNotFoundError('missing'))).toBe(404);
    expect(toClawHubHttpStatus(new Error('unknown'))).toBe(500);
  });

  it('validates clawhub slugs with strict pattern', () => {
    expect(isValidClawHubSlug('calendar')).toBe(true);
    expect(isValidClawHubSlug('google-calendar')).toBe(true);
    expect(isValidClawHubSlug('../calendar')).toBe(false);
    expect(isValidClawHubSlug('calendar/../../bad')).toBe(false);
  });
});
