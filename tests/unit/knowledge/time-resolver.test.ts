import { describe, it, expect } from 'vitest';
import {
  resolveRelativeTime,
  type TimeResolutionContext,
} from '../../../src/server/knowledge/timeResolver';

function makeContext(overrides: Partial<TimeResolutionContext> = {}): TimeResolutionContext {
  return {
    messageTimestamp: '2026-02-17T12:00:00Z',
    userTimezone: 'Europe/Berlin',
    ...overrides,
  };
}

describe('resolveRelativeTime', () => {
  it('resolves "gestern" to previous day', () => {
    const ctx = makeContext({ messageTimestamp: '2026-02-17T12:00:00Z' });
    const result = resolveRelativeTime('gestern war ich beim Arzt', ctx);
    expect(result).not.toBeNull();
    expect(result!.absoluteDate).toBe('2026-02-16');
    expect(result!.wasRelative).toBe(true);
    expect(result!.resolutionConfidence).toBeGreaterThanOrEqual(0.9);
  });

  it('resolves "vorgestern" to two days ago', () => {
    const ctx = makeContext({ messageTimestamp: '2026-02-17T12:00:00Z' });
    const result = resolveRelativeTime('vorgestern war Regen', ctx);
    expect(result).not.toBeNull();
    expect(result!.absoluteDate).toBe('2026-02-15');
    expect(result!.wasRelative).toBe(true);
  });

  it('resolves "in zwei Tagen" to future day', () => {
    const ctx = makeContext({ messageTimestamp: '2026-02-17T12:00:00Z' });
    const result = resolveRelativeTime('in zwei Tagen habe ich Termin', ctx);
    expect(result).not.toBeNull();
    expect(result!.absoluteDate).toBe('2026-02-19');
    expect(result!.wasRelative).toBe(true);
    expect(result!.resolutionConfidence).toBeGreaterThanOrEqual(0.8);
  });

  it('resolves "morgen" to next day', () => {
    const ctx = makeContext({ messageTimestamp: '2026-02-17T12:00:00Z' });
    const result = resolveRelativeTime('morgen gehe ich zum Arzt', ctx);
    expect(result).not.toBeNull();
    expect(result!.absoluteDate).toBe('2026-02-18');
    expect(result!.wasRelative).toBe(true);
  });

  it('resolves "heute" to same day', () => {
    const ctx = makeContext({ messageTimestamp: '2026-02-17T12:00:00Z' });
    const result = resolveRelativeTime('heute ist ein schoener Tag', ctx);
    expect(result).not.toBeNull();
    expect(result!.absoluteDate).toBe('2026-02-17');
    expect(result!.wasRelative).toBe(true);
  });

  it('resolves "letzte Woche" to date range', () => {
    const ctx = makeContext({ messageTimestamp: '2026-02-17T12:00:00Z' });
    const result = resolveRelativeTime('letzte Woche war ich krank', ctx);
    expect(result).not.toBeNull();
    expect(result!.absoluteDate).toBe('2026-02-09');
    expect(result!.absoluteDateEnd).toBe('2026-02-15');
    expect(result!.wasRelative).toBe(true);
  });

  it('resolves absolute German date with full confidence', () => {
    const ctx = makeContext();
    const result = resolveRelativeTime('am 15.02. war ich dort', ctx);
    expect(result).not.toBeNull();
    expect(result!.absoluteDate).toBe('2026-02-15');
    expect(result!.wasRelative).toBe(false);
    expect(result!.resolutionConfidence).toBe(1.0);
  });

  it('returns null for text without time expressions', () => {
    const ctx = makeContext();
    const result = resolveRelativeTime('Max ist mein Bruder', ctx);
    expect(result).toBeNull();
  });

  it('respects user timezone for edge case near midnight UTC', () => {
    // 2026-02-17T00:30:00Z = 2026-02-17T01:30 Berlin time
    // "gestern" in Berlin time = Feb 16
    const ctx = makeContext({
      messageTimestamp: '2026-02-17T00:30:00Z',
      userTimezone: 'Europe/Berlin',
    });
    const result = resolveRelativeTime('gestern war toll', ctx);
    expect(result).not.toBeNull();
    expect(result!.absoluteDate).toBe('2026-02-16');
  });

  it('falls back to UTC when no timezone provided', () => {
    const ctx = makeContext({
      messageTimestamp: '2026-02-17T12:00:00Z',
      userTimezone: null,
    });
    const result = resolveRelativeTime('gestern Abend', ctx);
    expect(result).not.toBeNull();
    expect(result!.absoluteDate).toBe('2026-02-16');
  });
});
