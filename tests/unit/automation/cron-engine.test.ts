import { describe, expect, it } from 'vitest';

import {
  computeNextRunAt,
  validateCronExpression,
} from '../../../src/server/automation/cronEngine';

describe('automation cron engine', () => {
  it('validates cron expressions', () => {
    expect(validateCronExpression('*/10 * * * *')).toBe(true);
    expect(validateCronExpression('invalid cron')).toBe(false);
  });

  it('computes next run using timezone with DST transitions', () => {
    const next = computeNextRunAt('0 10 * * *', 'Europe/Berlin', '2026-03-29T07:30:00.000Z');
    expect(next).toBe('2026-03-29T08:00:00.000Z');
  });
});
