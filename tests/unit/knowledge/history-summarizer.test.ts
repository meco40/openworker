import { describe, it, expect } from 'vitest';
import {
  buildHistorySummary,
  groupByWeek,
  type ConversationSummary,
} from '@/server/knowledge/historySummarizer';

function makeSummary(overrides: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id: 'sum-1',
    userId: 'user-1',
    personaId: 'persona-1',
    conversationId: 'conv-1',
    summaryText: 'Nata und der User sprachen ueber Familie.',
    keyTopics: ['Familie'],
    entitiesMentioned: [],
    emotionalTone: 'neutral',
    messageCount: 15,
    timeRangeStart: '2026-02-10T10:00:00Z',
    timeRangeEnd: '2026-02-10T11:00:00Z',
    createdAt: '2026-02-10T11:00:00Z',
    ...overrides,
  };
}

describe('buildHistorySummary', () => {
  it('returns empty string for no summaries', () => {
    expect(buildHistorySummary([], 'Nata', 3000)).toBe('');
  });

  it('builds chronological timeline from summaries', () => {
    const summaries = [
      makeSummary({
        id: 'sum-2',
        timeRangeStart: '2026-02-12T10:00:00Z',
        summaryText: 'Zweites Gespraech ueber Arbeit.',
        keyTopics: ['Arbeit'],
      }),
      makeSummary({
        id: 'sum-1',
        timeRangeStart: '2026-02-10T10:00:00Z',
        summaryText: 'Erstes Gespraech ueber Familie.',
        keyTopics: ['Familie'],
      }),
    ];
    const result = buildHistorySummary(summaries, 'Nata', 3000);
    expect(result).toContain('Bisheriger Verlauf');
    // Should be sorted: 10. before 12.
    const familieIdx = result.indexOf('Familie');
    const arbeitIdx = result.indexOf('Arbeit');
    expect(familieIdx).toBeLessThan(arbeitIdx);
  });

  it('truncates to budget', () => {
    const summaries = Array.from({ length: 20 }, (_, i) =>
      makeSummary({
        id: `sum-${i}`,
        timeRangeStart: `2026-02-${String(i + 1).padStart(2, '0')}T10:00:00Z`,
        summaryText: `Gespraech Nummer ${i + 1} war sehr lang und ausfuehrlich mit vielen Details.`,
      }),
    );
    const result = buildHistorySummary(summaries, 'Nata', 200);
    expect(result.length).toBeLessThanOrEqual(200);
  });

  it('includes topics in output', () => {
    const summaries = [makeSummary({ keyTopics: ['Notes2', 'Auth'] })];
    const result = buildHistorySummary(summaries, 'Nata', 3000);
    expect(result).toContain('Notes2');
  });
});

describe('groupByWeek', () => {
  it('groups summaries by ISO week', () => {
    const summaries = [
      makeSummary({ timeRangeStart: '2026-02-09T10:00:00Z' }), // week 7
      makeSummary({ timeRangeStart: '2026-02-10T10:00:00Z' }), // week 7
      makeSummary({ timeRangeStart: '2026-02-16T10:00:00Z' }), // week 8
    ];
    const weeks = groupByWeek(summaries);
    expect(weeks.length).toBe(2);
  });

  it('returns empty array for no summaries', () => {
    expect(groupByWeek([])).toEqual([]);
  });
});
