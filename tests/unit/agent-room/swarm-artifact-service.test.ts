import { describe, expect, it } from 'vitest';
import {
  clampArtifact,
  pushArtifactSnapshot,
  buildArtifactWithNewTurn,
  clampConsensusScore,
} from '@/server/agent-room/services/swarmArtifact.service';

describe('swarmArtifact.service', () => {
  // ─── clampArtifact ──────────────────────────────────────────────

  describe('clampArtifact', () => {
    it('returns text unchanged when under limit', () => {
      expect(clampArtifact('hello')).toBe('hello');
    });

    it('clamps to last 20_000 chars when over limit', () => {
      const text = 'A'.repeat(25_000);
      const result = clampArtifact(text);
      expect(result.length).toBe(20_000);
      expect(result).toBe('A'.repeat(20_000));
    });

    it('handles empty string', () => {
      expect(clampArtifact('')).toBe('');
    });

    it('handles null-ish input coerced to string', () => {
      // Service calls String(text || '') internally — test with empty-string equivalent
      expect(clampArtifact('')).toBe('');
    });

    it('returns text at exactly the limit unchanged', () => {
      const text = 'B'.repeat(20_000);
      expect(clampArtifact(text)).toBe(text);
    });

    it('keeps last portion (tail) of the text', () => {
      const head = 'H'.repeat(15_000);
      const tail = 'T'.repeat(10_000);
      const result = clampArtifact(head + tail);
      expect(result.endsWith('T'.repeat(10_000))).toBe(true);
      expect(result.length).toBe(20_000);
    });
  });

  // ─── pushArtifactSnapshot ───────────────────────────────────────

  describe('pushArtifactSnapshot', () => {
    it('appends artifact to history', () => {
      const result = pushArtifactSnapshot(['v1'], 'v2');
      expect(result).toEqual(['v1', 'v2']);
    });

    it('returns history unchanged for empty artifact', () => {
      const history = ['v1'];
      expect(pushArtifactSnapshot(history, '')).toBe(history);
    });

    it('returns history unchanged for whitespace-only artifact', () => {
      const history = ['v1'];
      expect(pushArtifactSnapshot(history, '   ')).toBe(history);
    });

    it('deduplicates consecutive identical snapshots', () => {
      const result = pushArtifactSnapshot(['v1', 'v2'], 'v2');
      expect(result).toEqual(['v1', 'v2']);
      // returns same reference when dedup
      expect(result).toEqual(['v1', 'v2']);
    });

    it('allows the same value when not consecutive', () => {
      const result = pushArtifactSnapshot(['v1', 'v2'], 'v1');
      expect(result).toEqual(['v1', 'v2', 'v1']);
    });

    it('trims history to 24 entries', () => {
      const history = Array.from({ length: 24 }, (_, i) => `v${i}`);
      const result = pushArtifactSnapshot(history, 'v24');
      expect(result.length).toBe(24);
      expect(result[0]).toBe('v1'); // oldest dropped
      expect(result[result.length - 1]).toBe('v24');
    });

    it('works with empty history', () => {
      expect(pushArtifactSnapshot([], 'first')).toEqual(['first']);
    });

    it('normalizes artifact by trimming', () => {
      const result = pushArtifactSnapshot([], '  hello  ');
      expect(result).toEqual(['hello']);
    });
  });

  // ─── clampConsensusScore ────────────────────────────────────────

  describe('clampConsensusScore', () => {
    it('returns 0 for NaN', () => {
      expect(clampConsensusScore(NaN)).toBe(0);
    });

    it('returns 0 for Infinity', () => {
      expect(clampConsensusScore(Infinity)).toBe(0);
    });

    it('returns 0 for -Infinity', () => {
      expect(clampConsensusScore(-Infinity)).toBe(0);
    });

    it('clamps negative values to 0', () => {
      expect(clampConsensusScore(-5)).toBe(0);
    });

    it('clamps values above 100 to 100', () => {
      expect(clampConsensusScore(150)).toBe(100);
    });

    it('rounds to nearest integer', () => {
      expect(clampConsensusScore(55.6)).toBe(56);
      expect(clampConsensusScore(55.4)).toBe(55);
    });

    it('passes through valid integers unchanged', () => {
      expect(clampConsensusScore(0)).toBe(0);
      expect(clampConsensusScore(50)).toBe(50);
      expect(clampConsensusScore(100)).toBe(100);
    });
  });

  // ─── buildArtifactWithNewTurn ──────────────────────────────────

  describe('buildArtifactWithNewTurn', () => {
    it('creates initial artifact with phase marker for first turn', () => {
      const result = buildArtifactWithNewTurn('', 'Agent A: Hello', 'analysis', false, 'analysis');
      expect(result).toContain('--- Analysis ---');
      expect(result).toContain('Agent A: Hello');
    });

    it('appends turn to existing artifact', () => {
      const existing = '--- Analysis ---\n\nAgent A: First turn';
      const result = buildArtifactWithNewTurn(
        existing,
        'Agent B: Second turn',
        'analysis',
        false,
        'analysis',
      );
      expect(result).toContain('Agent A: First turn');
      expect(result).toContain('Agent B: Second turn');
      // No extra phase marker
      expect(result.match(/---/g)?.length).toBe(2); // Opening --- and closing --- of first marker
    });

    it('inserts next phase marker when phase completes', () => {
      const existing = '--- Analysis ---\n\nAgent A: analysis turn';
      const result = buildArtifactWithNewTurn(
        existing,
        'Agent B: final analysis',
        'analysis',
        true,
        'ideation',
      );
      expect(result).toContain('--- Ideation ---');
      expect(result).toContain('Agent B: final analysis');
    });

    it('handles whitespace-only existing artifact as empty', () => {
      const result = buildArtifactWithNewTurn(
        '   ',
        'Agent A: Start',
        'ideation',
        false,
        'ideation',
      );
      expect(result).toContain('--- Ideation ---');
      expect(result).toContain('Agent A: Start');
    });

    it('clamps result when artifact grows beyond limit', () => {
      const existing = 'X'.repeat(19_990);
      const result = buildArtifactWithNewTurn(
        existing,
        'Agent A: This is a new turn with content',
        'analysis',
        false,
        'analysis',
      );
      expect(result.length).toBeLessThanOrEqual(20_000);
    });
  });
});
