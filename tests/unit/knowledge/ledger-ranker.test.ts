import { describe, expect, it } from 'vitest';

import type { MeetingLedgerEntry } from '@/server/knowledge/repository';
import { rankLedgerByQuery } from '@/server/knowledge/retrieval/ranking/ledgerRanker';

function buildLedgerRow(
  id: string,
  overrides: Partial<MeetingLedgerEntry> = {},
): MeetingLedgerEntry {
  return {
    id,
    userId: 'user-1',
    personaId: 'persona-1',
    conversationId: `conv-${id}`,
    topicKey: 'project-alpha',
    counterpart: 'Max',
    eventAt: null,
    participants: ['Ich', 'Max'],
    decisions: ['Projekt Alpha wurde priorisiert'],
    negotiatedTerms: [],
    openPoints: [],
    actionItems: [],
    sourceRefs: [],
    confidence: 0.8,
    updatedAt: '2026-02-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('rankLedgerByQuery', () => {
  it('returns original array when query yields no ranking tokens', () => {
    const rows = [buildLedgerRow('a'), buildLedgerRow('b')];

    const ranked = rankLedgerByQuery(rows, 'was ist das?');
    expect(ranked).toBe(rows);
  });

  it('ranks better token overlap above lower overlap', () => {
    const rows = [
      buildLedgerRow('low', {
        topicKey: 'unrelated-topic',
        decisions: ['anderes thema ohne begriffe'],
      }),
      buildLedgerRow('high', {
        topicKey: 'projekt-alpha',
        decisions: ['projekt alpha kickoff vereinbart'],
      }),
    ];

    const ranked = rankLedgerByQuery(rows, 'Status zu Projekt Alpha');
    expect(ranked[0]?.id).toBe('high');
  });

  it('prefers fresher entries when overlap is equal', () => {
    const rows = [
      buildLedgerRow('old', {
        updatedAt: '2025-01-01T00:00:00.000Z',
      }),
      buildLedgerRow('fresh', {
        updatedAt: '2026-02-20T00:00:00.000Z',
      }),
    ];

    const ranked = rankLedgerByQuery(rows, 'projekt alpha details');
    expect(ranked[0]?.id).toBe('fresh');
  });

  it('falls back to updatedAt date sorting when recall scores tie', () => {
    const rows = [
      buildLedgerRow('older', {
        topicKey: 'x',
        decisions: ['no overlap words'],
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
      buildLedgerRow('newer', {
        topicKey: 'y',
        decisions: ['still no overlap'],
        updatedAt: '2026-01-15T00:00:00.000Z',
      }),
    ];

    const ranked = rankLedgerByQuery(rows, 'zzzz notfound');
    expect(ranked[0]?.id).toBe('newer');
  });
});
