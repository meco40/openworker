import { describe, expect, it } from 'vitest';
import type {
  KnowledgeEpisode,
  KnowledgeMeetingLedgerEntry,
  KnowledgeRepository,
} from '../../../src/server/knowledge/repository';
import { KnowledgeRetrievalService } from '../../../src/server/knowledge/retrievalService';

function buildEpisode(input: Partial<KnowledgeEpisode> & Pick<KnowledgeEpisode, 'id'>): KnowledgeEpisode {
  return {
    id: input.id,
    userId: input.userId || 'user-1',
    personaId: input.personaId || 'persona-1',
    topicKey: input.topicKey || 'general',
    counterpart: input.counterpart || 'self',
    date: input.date || '2026-02-15',
    teaser: input.teaser || 'teaser',
    summary: input.summary || 'summary',
    sourceRefs: input.sourceRefs || ['msg:1'],
    createdAt: input.createdAt || '2026-02-15T10:00:00.000Z',
    updatedAt: input.updatedAt || '2026-02-15T10:00:00.000Z',
  };
}

function buildMeeting(input: Partial<KnowledgeMeetingLedgerEntry> & Pick<KnowledgeMeetingLedgerEntry, 'id'>): KnowledgeMeetingLedgerEntry {
  return {
    id: input.id,
    userId: input.userId || 'user-1',
    personaId: input.personaId || 'persona-1',
    counterpart: input.counterpart || 'andreas',
    topicKey: input.topicKey || 'meeting',
    date: input.date || '2026-02-15',
    decisions: input.decisions || [],
    negotiatedTerms: input.negotiatedTerms || [],
    openPoints: input.openPoints || [],
    actionItems: input.actionItems || [],
    sourceRefs: input.sourceRefs || ['msg:1'],
    createdAt: input.createdAt || '2026-02-15T10:00:00.000Z',
    updatedAt: input.updatedAt || '2026-02-15T10:00:00.000Z',
  };
}

function buildRepository(
  episodes: KnowledgeEpisode[],
  meetings: KnowledgeMeetingLedgerEntry[],
): Pick<
  KnowledgeRepository,
  'listEpisodes' | 'listMeetingLedgerEntries' | 'insertRetrievalAudit'
> {
  return {
    listEpisodes: () => episodes,
    listMeetingLedgerEntries: () => meetings,
    insertRetrievalAudit: () =>
      ({
        id: 'audit-1',
        userId: 'user-1',
        personaId: 'persona-1',
        queryText: 'query',
        counterpart: null,
        topicKey: null,
        date: null,
        resultIds: [],
        createdAt: '2026-02-15T10:00:00.000Z',
        updatedAt: '2026-02-15T10:00:00.000Z',
      }) as never,
  };
}

describe('KnowledgeRetrievalService', () => {
  it('returns sauna episode details for retrospective sauna question', () => {
    const repo = buildRepository(
      [
        buildEpisode({
          id: 'episode-sauna',
          topicKey: 'sauna',
          teaser: 'Mittags haben wir lange ueber Sauna gesprochen.',
          summary:
            'Du warst in der Sauna, wir haben ueber Temperatur, Dauer und Aufguss gesprochen.',
          sourceRefs: ['msg:11', 'msg:12'],
          date: '2026-02-15',
        }),
      ],
      [],
    );
    const service = new KnowledgeRetrievalService(repo, { now: new Date('2026-02-15T21:00:00Z') });

    const context = service.buildRecallContext({
      userId: 'user-1',
      personaId: 'persona-1',
      query: 'Was haben wir letztes ueber sauna gesprochen?',
    });

    expect(context).toContain('sauna');
    expect(context).toContain('Temperatur');
    expect(context).toContain('msg:11');
  });

  it('prefers meeting ledger details for long-range meeting query', () => {
    const repo = buildRepository(
      [],
      [
        buildMeeting({
          id: 'meeting-1',
          counterpart: 'andreas',
          topicKey: 'meeting',
          date: '2025-08-20',
          decisions: ['Projektstart Q4'],
          negotiatedTerms: ['Budgetobergrenze 30k'],
          openPoints: ['finale Laufzeit'],
          actionItems: ['Entwurf bis Freitag'],
          sourceRefs: ['msg:201', 'msg:203'],
        }),
      ],
    );
    const service = new KnowledgeRetrievalService(repo, { now: new Date('2026-02-15T21:00:00Z') });

    const context = service.buildRecallContext({
      userId: 'user-1',
      personaId: 'persona-1',
      query: 'Wie war vor 6 Monaten das Meeting mit Andreas und was haben wir ausgehandelt?',
    });

    expect(context).toContain('andreas');
    expect(context).toContain('Budgetobergrenze 30k');
    expect(context).toContain('Projektstart Q4');
  });
});
