import { describe, expect, it, vi } from 'vitest';

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

  it('detects yesterday, today, and month-based relative windows', () => {
    expect(planQuery({ text: 'Was habe ich gestern gemacht?', now: NOW }).timeWindow).toEqual({
      after: '2026-08-17T12:00:00.000Z',
      before: NOW,
      label: 'yesterday',
    });
    expect(planQuery({ text: 'Was ist heute geplant?', now: NOW }).timeWindow).toEqual({
      after: '2026-08-18T00:00:00.000Z',
      before: NOW,
      label: 'today',
    });
    expect(planQuery({ text: 'Was ist vor 2 Monaten geplant?', now: NOW }).timeWindow).toEqual({
      after: '2026-06-19T12:00:00.000Z',
      before: NOW,
      label: 'last_2_monaten',
    });
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

  it('detects who-involved and promised intents', () => {
    expect(planQuery({ text: 'Wer war dabei?', now: NOW }).intent).toBe('who_involved');
    expect(planQuery({ text: 'Was habe ich versprochen?', now: NOW }).intent).toBe('what_promised');
  });

  it('parses date-only, minute, and second precision as-of timestamps', () => {
    expect(planQuery({ text: 'Stand 2026-02-15', now: NOW })).toMatchObject({
      asOfValidTime: '2026-02-15T00:00:00.000Z',
      asOfKnownTime: '2026-02-15T00:00:00.000Z',
    });
    expect(planQuery({ text: 'as of 2026-02-15T09:30', now: NOW })).toMatchObject({
      asOfValidTime: '2026-02-15T09:30:00.000Z',
      asOfKnownTime: '2026-02-15T09:30:00.000Z',
    });
    expect(planQuery({ text: 'Zum Zeitpunkt 2026-02-15 09:30:12', now: NOW })).toMatchObject({
      asOfValidTime: '2026-02-15T09:30:12.000Z',
      asOfKnownTime: '2026-02-15T09:30:12.000Z',
    });
  });

  it('uses the current knowledge time for historical wording and ignores invalid dates', () => {
    expect(planQuery({ text: 'Was war damals?', now: NOW })).toMatchObject({
      asOfValidTime: undefined,
      asOfKnownTime: NOW,
    });
    expect(planQuery({ text: 'as of 2026-13-15', now: NOW })).toMatchObject({
      asOfValidTime: undefined,
      asOfKnownTime: undefined,
    });
    expect(planQuery({ text: 'as of 15.02.2026', now: NOW })).toMatchObject({
      asOfValidTime: undefined,
      asOfKnownTime: undefined,
    });
    expect(planQuery({ text: 'Stand 2026-02-15T09', now: NOW }).asOfValidTime).toBe(
      '2026-02-15T00:00:00.000Z',
    );
  });

  it('uses the current clock when no reference time is supplied', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    try {
      expect(planQuery({ text: 'Was ist heute geplant?' }).timeWindow?.before).toBe(NOW);
    } finally {
      vi.useRealTimers();
    }
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
