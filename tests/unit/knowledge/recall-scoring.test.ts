import { describe, it, expect } from 'vitest';
import { adjustRecallScore, isDuplicateContent } from '@/server/knowledge/recallScoring';

describe('isDuplicateContent', () => {
  it('detects exact duplicate (case-insensitive)', () => {
    expect(isDuplicateContent('Max ist mein Bruder', 'max ist mein bruder')).toBe(true);
  });

  it('detects duplicate with whitespace differences', () => {
    expect(isDuplicateContent('  Max ist mein Bruder  ', 'Max ist mein Bruder')).toBe(true);
  });

  it('returns false for different content', () => {
    expect(isDuplicateContent('Max ist mein Bruder', 'Lisa ist meine Schwester')).toBe(false);
  });

  it('returns false for similar but not identical content', () => {
    expect(isDuplicateContent('Max ist mein Bruder', 'Max ist mein Cousin')).toBe(false);
  });
});

describe('adjustRecallScore', () => {
  it('boosts fresh facts (< 7 days)', () => {
    const score = adjustRecallScore({
      baseScore: 0.8,
      confidence: 0.5,
      ageDays: 3,
    });
    // 0.8 * max(0.5, 0.5) * 1.0 = 0.4
    expect(score).toBeCloseTo(0.4, 1);
  });

  it('applies freshness decay for old facts (>90 days)', () => {
    const fresh = adjustRecallScore({ baseScore: 0.8, confidence: 0.5, ageDays: 3 });
    const old = adjustRecallScore({ baseScore: 0.8, confidence: 0.5, ageDays: 120 });
    expect(fresh).toBeGreaterThan(old);
  });

  it('boosts high-confidence facts', () => {
    const high = adjustRecallScore({ baseScore: 0.8, confidence: 0.9, ageDays: 10 });
    const low = adjustRecallScore({ baseScore: 0.8, confidence: 0.3, ageDays: 10 });
    expect(high).toBeGreaterThan(low);
  });

  it('returns 0 for superseded facts', () => {
    const score = adjustRecallScore({
      baseScore: 0.8,
      confidence: 0.9,
      ageDays: 1,
      isSupersceded: true,
    });
    expect(score).toBe(0);
  });

  it('applies temporal boost for current facts', () => {
    const current = adjustRecallScore({
      baseScore: 0.8,
      confidence: 0.5,
      ageDays: 10,
      temporalStatus: 'current',
    });
    const past = adjustRecallScore({
      baseScore: 0.8,
      confidence: 0.5,
      ageDays: 10,
      temporalStatus: 'past',
    });
    expect(current).toBeGreaterThan(past);
  });

  it('uses moderate decay for 30-90 day old facts', () => {
    const thirtyDay = adjustRecallScore({ baseScore: 0.8, confidence: 0.5, ageDays: 50 });
    const sevenDay = adjustRecallScore({ baseScore: 0.8, confidence: 0.5, ageDays: 5 });
    const ninetyDay = adjustRecallScore({ baseScore: 0.8, confidence: 0.5, ageDays: 100 });
    expect(sevenDay).toBeGreaterThan(thirtyDay);
    expect(thirtyDay).toBeGreaterThan(ninetyDay);
  });

  it('enforces minimum confidence floor of 0.5', () => {
    const veryLow = adjustRecallScore({ baseScore: 0.8, confidence: 0.1, ageDays: 3 });
    const atFloor = adjustRecallScore({ baseScore: 0.8, confidence: 0.5, ageDays: 3 });
    expect(veryLow).toBe(atFloor);
  });
});
