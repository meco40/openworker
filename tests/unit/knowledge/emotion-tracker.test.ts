import { describe, it, expect } from 'vitest';
import {
  detectEmotion,
  deriveRelationshipTrend,
  type RelationshipStatus,
} from '../../../src/server/knowledge/emotionTracker';

describe('detectEmotion', () => {
  it('detects sadness', () => {
    const result = detectEmotion('Ich bin gerade so traurig');
    expect(result).not.toBeNull();
    expect(result!.emotion).toBe('traurig');
    expect(result!.intensity).toBeGreaterThan(0.5);
  });

  it('detects happiness', () => {
    const result = detectEmotion('Ich bin so gluecklich heute!');
    expect(result).not.toBeNull();
    expect(result!.emotion).toBe('gluecklich');
  });

  it('detects anger', () => {
    const result = detectEmotion('Das macht mich so wuetend');
    expect(result).not.toBeNull();
    expect(result!.emotion).toBe('wuetend');
  });

  it('detects trigger phrase', () => {
    const result = detectEmotion('Ich bin traurig wegen Max');
    expect(result).not.toBeNull();
    expect(result!.trigger).toBe('wegen Max');
  });

  it('returns null for non-emotional text', () => {
    const result = detectEmotion('Die Sonne scheint heute');
    expect(result).toBeNull();
  });

  it('detects anxiety', () => {
    const result = detectEmotion('Ich habe solche Angst vor morgen');
    expect(result).not.toBeNull();
    expect(result!.emotion).toBe('aengstlich');
  });
});

describe('deriveRelationshipTrend', () => {
  it('returns improving when recent status is better', () => {
    const history: RelationshipStatus[] = ['tense', 'neutral', 'positive'];
    expect(deriveRelationshipTrend(history)).toBe('improving');
  });

  it('returns declining when recent status is worse', () => {
    const history: RelationshipStatus[] = ['positive', 'neutral', 'tense'];
    expect(deriveRelationshipTrend(history)).toBe('declining');
  });

  it('returns stable when status unchanged', () => {
    const history: RelationshipStatus[] = ['positive', 'positive', 'positive'];
    expect(deriveRelationshipTrend(history)).toBe('stable');
  });

  it('returns stable for single entry', () => {
    const history: RelationshipStatus[] = ['neutral'];
    expect(deriveRelationshipTrend(history)).toBe('stable');
  });

  it('returns stable for empty history', () => {
    expect(deriveRelationshipTrend([])).toBe('stable');
  });
});
