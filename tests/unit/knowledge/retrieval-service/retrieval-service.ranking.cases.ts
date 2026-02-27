import { describe, expect, it, vi } from 'vitest';
import type { StoredMessage } from '@/server/channels/messages/repository';
import { KnowledgeRetrievalService } from '@/server/knowledge/retrievalService';
import { makeMessage } from './retrieval-service.harness';

describe('KnowledgeRetrievalService', () => {
  it('falls back to unfiltered topic query when strict topic filter returns no rows', async () => {
    const ledgerWithTopic = vi.fn((filter?: { topicKey?: string }) => {
      if (filter?.topicKey) return [];
      return [
        {
          id: 'led-fallback',
          userId: 'user-1',
          personaId: 'persona-1',
          conversationId: 'conv-1',
          topicKey: 'general-meeting',
          counterpart: null,
          eventAt: '2025-08-11T09:00:00.000Z',
          participants: [],
          decisions: ['Sauna-Regel aus allgemeinem Meeting-Kontext'],
          negotiatedTerms: [],
          openPoints: [],
          actionItems: [],
          sourceRefs: [{ seq: 2, quote: 'Sauna-Regel' }],
          confidence: 0.8,
          updatedAt: '2025-08-11T10:00:00.000Z',
        },
      ];
    });
    const episodesWithTopic = vi.fn((filter?: { topicKey?: string }) => {
      if (filter?.topicKey) return [];
      return [
        {
          id: 'ep-fallback',
          userId: 'user-1',
          personaId: 'persona-1',
          conversationId: 'conv-1',
          topicKey: 'general-meeting',
          counterpart: null,
          teaser: 'Sauna aus allgemeinem Meeting erwaehnt',
          episode: 'Wir sprachen ueber Regeln und Sauna im allgemeinen Meeting.',
          facts: ['Sauna-Regel aus Meeting'],
          sourceSeqStart: 1,
          sourceSeqEnd: 4,
          sourceRefs: [{ seq: 2, quote: 'Sauna-Regel' }],
          eventAt: '2025-08-11T09:00:00.000Z',
          updatedAt: '2025-08-11T10:00:00.000Z',
        },
      ];
    });

    const service = new KnowledgeRetrievalService({
      maxContextTokens: 1200,
      knowledgeRepository: {
        listMeetingLedger: ledgerWithTopic,
        listEpisodes: episodesWithTopic,
        insertRetrievalAudit: vi.fn(() => ({
          id: 'audit-fallback',
          userId: 'user-1',
          personaId: 'persona-1',
          conversationId: 'conv-1',
          query: 'heute mittag sauna',
          stageStats: {},
          tokenCount: 0,
          hadError: false,
          errorMessage: null,
          createdAt: new Date().toISOString(),
        })),
      },
      memoryService: {
        recallDetailed: vi.fn(async () => ({ context: '', matches: [] })),
      },
      messageRepository: {
        listMessages: vi.fn(() => []),
      },
    });

    const result = await service.retrieve({
      userId: 'user-1',
      personaId: 'persona-1',
      conversationId: 'conv-1',
      query: 'heute mittag sauna',
    });

    expect(result.sections.keyDecisions).toContain('Sauna-Regel aus allgemeinem Meeting-Kontext');
    expect(ledgerWithTopic).toHaveBeenCalledTimes(2);
    expect(episodesWithTopic).toHaveBeenCalledTimes(2);
    expect(
      ledgerWithTopic.mock.calls.some(
        (call) => ((call?.[0] as { topicKey?: string } | undefined)?.topicKey ?? null) === null,
      ),
    ).toBe(true);
    expect(
      episodesWithTopic.mock.calls.some(
        (call) => ((call?.[0] as { topicKey?: string } | undefined)?.topicKey ?? null) === null,
      ),
    ).toBe(true);
  });

  it('ranks fresher episodes higher when token overlap is equal', async () => {
    const now = new Date();
    const recentDate = new Date(now.getTime() - 2 * 86400000).toISOString(); // 2 days ago
    const oldDate = new Date(now.getTime() - 120 * 86400000).toISOString(); // 120 days ago

    const service = new KnowledgeRetrievalService({
      maxContextTokens: 1200,
      knowledgeRepository: {
        listMeetingLedger: vi.fn(() => []),
        listEpisodes: vi.fn(() => [
          {
            id: 'ep-old',
            userId: 'user-1',
            personaId: 'persona-1',
            conversationId: 'conv-1',
            topicKey: 'projekt-alpha',
            counterpart: 'Max',
            teaser: 'Altes Projekt Alpha Treffen',
            episode: 'Wir haben ueber Projekt Alpha gesprochen',
            facts: ['Projekt Alpha wurde geplant'],
            sourceSeqStart: 1,
            sourceSeqEnd: 3,
            sourceRefs: [{ seq: 1, quote: 'Alpha geplant' }],
            eventAt: oldDate,
            updatedAt: oldDate,
          },
          {
            id: 'ep-fresh',
            userId: 'user-1',
            personaId: 'persona-1',
            conversationId: 'conv-2',
            topicKey: 'projekt-alpha',
            counterpart: 'Max',
            teaser: 'Frisches Projekt Alpha Update',
            episode: 'Neues Update zu Projekt Alpha',
            facts: ['Projekt Alpha laeuft gut'],
            sourceSeqStart: 1,
            sourceSeqEnd: 3,
            sourceRefs: [{ seq: 1, quote: 'Alpha laeuft' }],
            eventAt: recentDate,
            updatedAt: recentDate,
          },
        ]),
        insertRetrievalAudit: vi.fn(() => ({
          id: 'audit-2',
          userId: 'user-1',
          personaId: 'persona-1',
          conversationId: 'conv-1',
          query: 'Projekt Alpha',
          stageStats: {},
          tokenCount: 10,
          hadError: false,
          errorMessage: null,
          createdAt: now.toISOString(),
        })),
      },
      memoryService: {
        recallDetailed: vi.fn(async () => ({ context: '', matches: [] })),
      },
      messageRepository: {
        listMessages: vi.fn((): StoredMessage[] => [
          {
            id: 'm-1',
            conversationId: 'conv-2',
            seq: 1,
            role: 'user',
            content: 'Alpha Status',
            platform: 'WebChat' as never,
            externalMsgId: null,
            senderName: null,
            metadata: null,
            createdAt: recentDate,
          },
        ]),
      },
    });

    const result = await service.retrieve({
      userId: 'user-1',
      personaId: 'persona-1',
      conversationId: 'conv-1',
      query: 'Was ist der Stand von Projekt Alpha',
    });

    // The fresh episode should be the top-ranked one (episodes[0]),
    // making its teaser appear in the answerDraft
    const answerDraft = result.sections.answerDraft;
    expect(answerDraft).toContain('Frisches Projekt Alpha Update');
    // And its facts should appear in keyDecisions
    expect(result.sections.keyDecisions).toContain('Projekt Alpha laeuft gut');
  });

  it('returns "Unklar" when evidence contains a user/assistant contradiction for binary recall query', async () => {
    const service = new KnowledgeRetrievalService({
      maxContextTokens: 1200,
      knowledgeRepository: {
        listMeetingLedger: vi.fn(() => [
          {
            id: 'led-sauna',
            userId: 'user-1',
            personaId: 'persona-1',
            conversationId: 'conv-1',
            topicKey: 'general-meeting',
            counterpart: null,
            eventAt: '2026-02-22T02:53:50.000Z',
            participants: [],
            decisions: [],
            negotiatedTerms: [],
            openPoints: [],
            actionItems: [],
            sourceRefs: [
              { seq: 55, quote: 'Doch wir waren schon mal in der Sauna' },
              { seq: 56, quote: 'Oh, nein, wir waren nie zusammen in der Sauna.' },
            ],
            confidence: 0.8,
            updatedAt: '2026-02-22T02:53:55.000Z',
          },
        ]),
        listEpisodes: vi.fn(() => [
          {
            id: 'ep-sauna',
            userId: 'user-1',
            personaId: 'persona-1',
            conversationId: 'conv-1',
            topicKey: 'general-meeting',
            counterpart: null,
            teaser: 'Sauna-Rueckblick',
            episode: 'Es gibt gemischte Aussagen zur Sauna.',
            facts: ['Nata Girl und Meco waren nie zusammen in der Sauna.'],
            sourceSeqStart: 51,
            sourceSeqEnd: 56,
            sourceRefs: [
              { seq: 55, quote: 'Doch wir waren schon mal in der Sauna' },
              { seq: 56, quote: 'Oh, nein, wir waren nie zusammen in der Sauna.' },
            ],
            eventAt: '2026-02-22T02:53:55.000Z',
            updatedAt: '2026-02-22T02:53:55.000Z',
          },
        ]),
        listEntities: vi.fn(() => []),
        listEvents: vi.fn(() => []),
        insertRetrievalAudit: vi.fn(() => ({
          id: 'audit-contradiction',
          userId: 'user-1',
          personaId: 'persona-1',
          conversationId: 'conv-1',
          query: 'Waren wir schon mal in der Sauna?',
          stageStats: {},
          tokenCount: 0,
          hadError: false,
          errorMessage: null,
          createdAt: new Date().toISOString(),
        })),
      },
      memoryService: {
        recallDetailed: vi.fn(async () => ({ context: '', matches: [] })),
      },
      messageRepository: {
        listMessages: vi.fn(() => [
          makeMessage(55, 'Doch wir waren schon mal in der Sauna'),
          makeMessage(56, 'Oh, nein, wir waren nie zusammen in der Sauna.'),
        ]),
      },
    });

    const result = await service.retrieve({
      userId: 'user-1',
      personaId: 'persona-1',
      conversationId: 'conv-1',
      query: 'Waren wir schon mal in der Sauna?',
    });

    expect(result.sections.answerDraft.toLowerCase()).toContain('unklar');
    expect(result.sections.keyDecisions.toLowerCase()).toContain('widerspruch');
    expect(result.references).toContain('seq:55');
    expect(result.references).toContain('seq:56');
  });
});
