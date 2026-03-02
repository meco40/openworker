import { describe, expect, it } from 'vitest';
import { formatDateTime, formatNumber } from '@/shared/lib/dateFormat';

describe('dateFormat helpers', () => {
  it('returns fallback for missing datetime values', () => {
    expect(formatDateTime(null)).toBe('n/a');
    expect(formatDateTime(undefined, { fallback: '-' })).toBe('-');
  });

  it('returns the raw value when datetime is invalid', () => {
    expect(formatDateTime('not-a-date')).toBe('not-a-date');
  });

  it('formats datetime with locale and explicit options', () => {
    const iso = '2026-03-02T12:34:56.000Z';
    const format: Intl.DateTimeFormatOptions = {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    };
    expect(formatDateTime(iso, { locale: 'de-DE', format })).toBe(
      new Date(iso).toLocaleString('de-DE', format),
    );
  });

  it('formats numbers with locale support', () => {
    expect(formatNumber(1234567.89, 'de-DE')).toBe((1234567.89).toLocaleString('de-DE'));
  });
});
