import { describe, expect, it } from 'vitest';

import { extractEntityMention, planQuery } from '@/server/world-model/retrieval/queryPlanner';

const NOW = '2026-08-18T12:00:00.000Z';

describe('planQuery', () => {
  it('detects "letzte Woche" and what_done intent', () => {
    const plan = planQuery({ text: 'Was habe ich letzte Woche gemacht?', now: NOW });
    expect(plan.intent).toBe('what_done');
    expect(plan.timeWindow?.label).toBe('last_week');
    expect(plan.timeWindow?.after).toBeDefined();
    expect(plan.timeWindow?.before).toBe(NOW);
  });

  it('detects relative duration "vor 2 Wochen"', () => {
    const plan = planQuery({ text: 'Was ist vor 2 Wochen passiert?', now: NOW });
    expect(plan.timeWindow?.label).toBe('last_2_wochen');
  });

  it('detects what_planned intent', () => {
    expect(planQuery({ text: 'Was ist diese Woche geplant?', now: NOW }).intent).toBe(
      'what_planned',
    );
  });

  it('detects what_cancelled intent', () => {
    expect(planQuery({ text: 'Was wurde abgesagt?', now: NOW }).intent).toBe('what_cancelled');
  });

  it('detects what_open intent', () => {
    expect(planQuery({ text: 'Was steht noch offen?', now: NOW }).intent).toBe('what_open');
  });

  it('falls back to generic intent when nothing matches', () => {
    expect(planQuery({ text: 'Erzaehl mir etwas', now: NOW }).intent).toBe('generic');
  });
});

describe('extractEntityMention', () => {
  it('extracts a proper noun after a preposition', () => {
    expect(extractEntityMention('Rueckblick mit Mike')).toBe('Mike');
  });

  it('returns undefined when no mention', () => {
    expect(extractEntityMention('Was habe ich gemacht?')).toBeUndefined();
  });
});
