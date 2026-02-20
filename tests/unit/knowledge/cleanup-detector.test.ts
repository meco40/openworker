import { describe, it, expect } from 'vitest';
import {
  detectPlaceholder,
  detectStaleRelativeTime,
  detectLowRelevance,
} from '@/server/knowledge/cleanupDetector';

describe('detectPlaceholder', () => {
  it('detects "die Protagonistin" as placeholder', () => {
    expect(detectPlaceholder('Die Protagonistin war traurig')).toBe(true);
  });

  it('detects "der Protagonist" as placeholder', () => {
    expect(detectPlaceholder('Der Protagonist ging spazieren')).toBe(true);
  });

  it('does not flag named entities', () => {
    expect(detectPlaceholder('Nata war traurig')).toBe(false);
  });

  it('detects "the character" pattern', () => {
    expect(detectPlaceholder('The character was happy')).toBe(true);
  });
});

describe('detectStaleRelativeTime', () => {
  it('detects "morgen" in old fact', () => {
    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    expect(detectStaleRelativeTime('Arzttermin morgen', fiveDaysAgo)).toBe(true);
  });

  it('does not flag recent relative time', () => {
    const now = new Date().toISOString();
    expect(detectStaleRelativeTime('Arzttermin morgen', now)).toBe(false);
  });

  it('detects "naechste Woche" in old fact', () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    expect(detectStaleRelativeTime('Training naechste Woche', tenDaysAgo)).toBe(true);
  });

  it('detects "in zwei Tagen" in old fact', () => {
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    expect(detectStaleRelativeTime('Meeting in zwei Tagen', weekAgo)).toBe(true);
  });
});

describe('detectLowRelevance', () => {
  it('detects "Guten Morgen" as low relevance', () => {
    expect(detectLowRelevance('Guten Morgen')).toBe(true);
  });

  it('detects greetings as low relevance', () => {
    expect(detectLowRelevance('Hallo, wie gehts?')).toBe(true);
  });

  it('does not flag substantive facts', () => {
    expect(detectLowRelevance('Max ist mein Bruder und er ist 28 Jahre alt')).toBe(false);
  });

  it('detects very short messages as low relevance', () => {
    expect(detectLowRelevance('Ok')).toBe(true);
  });
});
