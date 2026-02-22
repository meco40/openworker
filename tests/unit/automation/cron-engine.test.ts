import { describe, expect, it } from 'vitest';

import {
  computeNextRunAt,
  intervalToCronExpression,
  validateCronExpression,
  validateTimezone,
} from '@/server/automation/cronEngine';

describe('automation cron engine', () => {
  it('validates cron expressions', () => {
    expect(validateCronExpression('*/10 * * * *')).toBe(true);
    expect(validateCronExpression('invalid cron')).toBe(false);
    expect(validateCronExpression('*/10 * * * *', 'Invalid/Timezone')).toBe(false);
  });

  it('computes next run using timezone with DST transitions', () => {
    const next = computeNextRunAt('0 10 * * *', 'Europe/Berlin', '2026-03-29T07:30:00.000Z');
    expect(next).toBe('2026-03-29T08:00:00.000Z');
  });

  it('throws for invalid timezone when computing next run', () => {
    expect(() => computeNextRunAt('* * * * *', 'Invalid/Timezone')).toThrow(
      'Invalid timezone: Invalid/Timezone',
    );
  });

  it('validates timezones via Intl', () => {
    expect(validateTimezone('UTC')).toBe(true);
    expect(validateTimezone('Invalid/Timezone')).toBe(false);
  });

  it('maps interval shorthand to cron expression', () => {
    expect(intervalToCronExpression('5m')).toBe('*/5 * * * *');
    expect(intervalToCronExpression('2h')).toBe('0 */2 * * *');
    expect(intervalToCronExpression('3d')).toBe('0 0 */3 * *');
  });

  it('rejects invalid interval shorthand values', () => {
    expect(intervalToCronExpression('')).toBeNull();
    expect(intervalToCronExpression('0m')).toBeNull();
    expect(intervalToCronExpression('60m')).toBeNull();
    expect(intervalToCronExpression('24h')).toBeNull();
    expect(intervalToCronExpression('32d')).toBeNull();
    expect(intervalToCronExpression('10w')).toBeNull();
  });
});
