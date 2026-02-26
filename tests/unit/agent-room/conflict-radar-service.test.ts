import { describe, expect, it } from 'vitest';
import { deriveConflictRadar } from '@/server/agent-room/services/conflictRadar.service';

describe('deriveConflictRadar', () => {
  // ─── Empty / trivial input ───────────────────────────────────────

  it('returns low/0 for empty string', () => {
    const result = deriveConflictRadar('');
    expect(result.level).toBe('low');
    expect(result.confidence).toBe(0);
    expect(result.hold).toBe(false);
    expect(result.reasons).toEqual([]);
  });

  it('returns low/0 for whitespace-only input', () => {
    const result = deriveConflictRadar('   \n\n  ');
    expect(result.level).toBe('low');
    expect(result.confidence).toBe(0);
    expect(result.reasons).toEqual([]);
  });

  it('returns low/0 for null-ish input coerced to string', () => {
    // Service calls String(artifact || '') internally — test with empty-string equivalent
    const result = deriveConflictRadar('');
    expect(result.level).toBe('low');
    expect(result.confidence).toBe(0);
  });

  // ─── No signals ─────────────────────────────────────────────────

  it('returns low for text without any risk signals', () => {
    const result = deriveConflictRadar('Everything is going well. The plan looks great.');
    expect(result.level).toBe('low');
    expect(result.confidence).toBe(0);
    expect(result.reasons).toEqual([]);
  });

  // ─── Single risk keyword ────────────────────────────────────────

  it('detects a single English risk keyword', () => {
    const result = deriveConflictRadar('There is a risk that this approach may fail.');
    expect(result.level).toBe('low');
    expect(result.confidence).toBe(25);
    expect(result.reasons.length).toBeGreaterThanOrEqual(1);
    expect(result.reasons[0]).toContain('Risk keywords (EN)');
  });

  it('detects a single German risk keyword', () => {
    const result = deriveConflictRadar('Es besteht ein Risiko bei diesem Ansatz.');
    expect(result.level).toBe('low');
    expect(result.confidence).toBe(25);
    expect(result.reasons.length).toBeGreaterThanOrEqual(1);
    expect(result.reasons[0]).toContain('Risk keywords (DE)');
  });

  // ─── Multiple risk keywords → medium ────────────────────────────

  it('returns medium when multiple risk signals are present', () => {
    // "risk" triggers Risk keywords (EN), "disagree" triggers Disagreement signal → 2 × 25 = 50 → medium
    const text = 'There is a risk here. The team members disagree on the approach strongly.';
    const result = deriveConflictRadar(text);
    expect(result.level).toBe('medium');
    expect(result.confidence).toBeGreaterThanOrEqual(30);
  });

  // ─── Severe signals ─────────────────────────────────────────────

  it('detects [VOTE:DOWN] as severe signal', () => {
    const result = deriveConflictRadar('I strongly [VOTE:DOWN] this proposal.');
    expect(result.confidence).toBe(35);
    expect(result.reasons.some((r) => r.includes('Agent voted DOWN'))).toBe(true);
  });

  it('detects critical blocker keywords as severe', () => {
    const result = deriveConflictRadar('This is a fatal flaw in the design.');
    expect(result.confidence).toBe(35);
    expect(result.reasons.some((r) => r.includes('Critical blocker'))).toBe(true);
  });

  // ─── High level (score >= 65) ───────────────────────────────────

  it('returns high when combining risk + severe signals', () => {
    const text =
      'There is a risk in this approach. Also a conflict exists. [VOTE:DOWN] This is impossible to implement.';
    const result = deriveConflictRadar(text);
    // risk(EN) 25 + disagree(contradict?) no, risk=25, severe(VOTE:DOWN)=35, severe(impossible)=35
    // Actually: risk EN = 25, VOTE:DOWN = 35, "impossible" = 35 = 95 capped at 100
    expect(result.level).toBe('high');
    expect(result.confidence).toBeGreaterThanOrEqual(65);
  });

  // ─── Confidence cap at 100 ──────────────────────────────────────

  it('caps confidence at 100', () => {
    const text =
      'risk conflict blocker unclear doubt contradict inconsistent disagree fatal critical failure impossible [VOTE:DOWN]';
    const result = deriveConflictRadar(text);
    expect(result.confidence).toBeLessThanOrEqual(100);
  });

  // ─── Phase marker isolation ─────────────────────────────────────

  it('only analyzes text after the last phase marker', () => {
    const artifact = [
      'There is a fatal risk and conflict here.',
      '--- Analysis Phase ---',
      'Everything looks great and safe.',
    ].join('\n');
    const result = deriveConflictRadar(artifact);
    // The risk text is before the marker, so should be ignored
    expect(result.level).toBe('low');
    expect(result.confidence).toBe(0);
    expect(result.reasons).toEqual([]);
  });

  it('analyzes text after the latest marker when multiple markers exist', () => {
    const artifact = [
      'fatal error here',
      '--- Analysis Phase ---',
      'still a fatal problem here',
      '--- Ideation Phase ---',
      'No issues in this section.',
    ].join('\n');
    const result = deriveConflictRadar(artifact);
    expect(result.level).toBe('low');
    expect(result.confidence).toBe(0);
  });

  it('returns low when text after last marker is empty', () => {
    const artifact = 'Some risky content\n--- Analysis Phase ---\n   ';
    const result = deriveConflictRadar(artifact);
    expect(result.level).toBe('low');
    expect(result.confidence).toBe(0);
  });

  // ─── Reason excerpts ───────────────────────────────────────────

  it('includes an excerpt in reasons when a sentence matches', () => {
    const result = deriveConflictRadar(
      'The plan is solid. However there is a clear risk that the timeline is too aggressive.',
    );
    expect(result.reasons.length).toBeGreaterThanOrEqual(1);
    // Should contain a quoted excerpt
    expect(result.reasons[0]).toMatch(/: "/);
  });

  it('truncates long excerpts to 120 characters', () => {
    const longSentence = `There is a risk that ${'x'.repeat(200)}.`;
    const result = deriveConflictRadar(longSentence);
    for (const reason of result.reasons) {
      // The quoted portion should be ≤ 120 chars + ellipsis
      const match = reason.match(/: "(.+?)"/);
      if (match) {
        expect(match[1].replace('…', '').length).toBeLessThanOrEqual(120);
      }
    }
  });

  // ─── Output shape ──────────────────────────────────────────────

  it('always returns hold: false', () => {
    const result = deriveConflictRadar('fatal critical failure impossible [VOTE:DOWN]');
    expect(result.hold).toBe(false);
  });

  it('always includes updatedAt as ISO timestamp', () => {
    const result = deriveConflictRadar('hello');
    expect(result.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
