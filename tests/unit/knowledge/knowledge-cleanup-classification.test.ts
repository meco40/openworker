import { describe, expect, it } from 'vitest';
import {
  detectPlaceholder,
  detectStaleRelativeTime,
  detectLowRelevance,
} from '../../../src/server/knowledge/cleanupDetector';

/**
 * Integration test: validates the cleanupDetector functions
 * work correctly in the classification context used by
 * scripts/knowledge-cleanup-entity-drift.ts
 */
describe('knowledge cleanup classification', () => {
  it('detects placeholder entities that should be cleaned', () => {
    expect(detectPlaceholder('Die Figur sagt etwas')).toBe(true);
    expect(detectPlaceholder('Der Protagonist hat ein Ziel')).toBe(true);
    expect(detectPlaceholder('Max hat ein Ziel')).toBe(false);
  });

  it('detects stale relative times from old facts', () => {
    const oldDate = new Date(Date.now() - 5 * 86400000).toISOString(); // 5 days ago
    const freshDate = new Date(Date.now() - 60000).toISOString(); // 1 minute ago

    expect(detectStaleRelativeTime('Morgen habe ich einen Termin', oldDate)).toBe(true);
    expect(detectStaleRelativeTime('Morgen habe ich einen Termin', freshDate)).toBe(false);
    expect(detectStaleRelativeTime('Max ist mein Bruder', oldDate)).toBe(false);
  });

  it('detects low-relevance content like greetings', () => {
    expect(detectLowRelevance('Hallo')).toBe(true);
    expect(detectLowRelevance('ok')).toBe(true);
    expect(detectLowRelevance('ja')).toBe(true);
    expect(detectLowRelevance('Max arbeitet bei Google als Entwickler')).toBe(false);
  });

  it('correctly skips substantive content', () => {
    expect(detectPlaceholder('Max arbeitet jeden Montag im Buero')).toBe(false);
    expect(detectLowRelevance('Wir haben ueber die Projektplanung gesprochen')).toBe(false);
  });
});
