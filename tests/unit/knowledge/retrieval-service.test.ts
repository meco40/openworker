import { describe, expect, it, vi } from 'vitest';
import type { StoredMessage } from '../../../src/server/channels/messages/repository';
import { KnowledgeRetrievalService } from '../../../src/server/knowledge/retrievalService';

function makeMessage(seq: number, content: string): StoredMessage {
  return {
    id: `m-${seq}`,
    conversationId: 'conv-1',
    seq,
    role: seq % 2 === 0 ? 'agent' : 'user',
    content,
    platform: 'WebChat' as never,
    externalMsgId: null,
    senderName: null,
    metadata: null,
    createdAt: new Date(2025, 7, 10, 9, seq).toISOString(),
  };
}

describe('KnowledgeRetrievalService', () => {
  it('retrieves in staged order and returns evidence references', async () => {
    const calls: string[] = [];

    const service = new KnowledgeRetrievalService({
      maxContextTokens: 1200,
      knowledgeRepository: {
        listMeetingLedger: vi.fn(() => {
          calls.push('ledger');
          return [
            {
              id: 'led-1',
              userId: 'user-1',
              personaId: 'persona-1',
              conversationId: 'conv-1',
              topicKey: 'meeting-andreas',
              counterpart: 'Andreas',
              eventAt: '2025-08-11T09:00:00.000Z',
              participants: ['Ich', 'Andreas'],
              decisions: ['8% Rabatt beschlossen'],
              negotiatedTerms: ['8% Rabatt fuer 12 Monate'],
              openPoints: ['SLA-Freigabe offen'],
              actionItems: ['Andreas sendet Vertragsentwurf'],
              sourceRefs: [{ seq: 2, quote: '8 Prozent Rabatt' }],
              confidence: 0.88,
              updatedAt: '2025-08-11T10:00:00.000Z',
            },
          ];
        }),
        listEpisodes: vi.fn(() => {
          calls.push('episodes');
          return [
            {
              id: 'ep-1',
              userId: 'user-1',
              personaId: 'persona-1',
              conversationId: 'conv-1',
              topicKey: 'meeting-andreas',
              counterpart: 'Andreas',
              teaser: 'Kurzfassung',
              episode: 'Ausfuehrliche Episode',
              facts: ['8% Rabatt vereinbart'],
              sourceSeqStart: 1,
              sourceSeqEnd: 3,
              sourceRefs: [{ seq: 2, quote: '8 Prozent Rabatt' }],
              eventAt: '2025-08-11T09:00:00.000Z',
              updatedAt: '2025-08-11T10:00:00.000Z',
            },
          ];
        }),
        insertRetrievalAudit: vi.fn(() => ({
          id: 'audit-1',
          userId: 'user-1',
          personaId: 'persona-1',
          conversationId: 'conv-1',
          query: 'was haben wir ausgehandelt',
          stageStats: {},
          tokenCount: 10,
          hadError: false,
          errorMessage: null,
          createdAt: new Date().toISOString(),
        })),
      },
      memoryService: {
        recallDetailed: vi.fn(async () => {
          calls.push('semantic');
          return {
            context: '[Type: fact] 8% Rabatt vereinbart',
            matches: [],
          };
        }),
      },
      messageRepository: {
        listMessages: vi.fn(() => {
          calls.push('evidence');
          return [makeMessage(1, 'Start'), makeMessage(2, 'Wir vereinbaren 8% Rabatt')];
        }),
      },
    });

    const result = await service.retrieve({
      userId: 'user-1',
      personaId: 'persona-1',
      conversationId: 'conv-1',
      query: 'meeting mit andreas vor 6 monaten was haben wir ausgehandelt',
    });

    expect(calls).toEqual(['ledger', 'episodes', 'semantic', 'evidence']);
    expect(result.sections.keyDecisions).toContain('8% Rabatt beschlossen');
    expect(result.sections.evidence).toContain('seq:2');
    expect(result.references.length).toBeGreaterThan(0);
  });

  it('enforces hard context token budget', async () => {
    const longText = Array.from({ length: 2000 }, (_, idx) => `token${idx}`).join(' ');

    const service = new KnowledgeRetrievalService({
      maxContextTokens: 80,
      knowledgeRepository: {
        listMeetingLedger: vi.fn(() => []),
        listEpisodes: vi.fn(() => [
          {
            id: 'ep-long',
            userId: 'user-1',
            personaId: 'persona-1',
            conversationId: 'conv-1',
            topicKey: 'topic',
            counterpart: null,
            teaser: longText,
            episode: longText,
            facts: ['x'],
            sourceSeqStart: 1,
            sourceSeqEnd: 1,
            sourceRefs: [{ seq: 1, quote: 'x' }],
            eventAt: null,
            updatedAt: new Date().toISOString(),
          },
        ]),
        insertRetrievalAudit: vi.fn(() => ({
          id: 'audit-1',
          userId: 'user-1',
          personaId: 'persona-1',
          conversationId: 'conv-1',
          query: 'q',
          stageStats: {},
          tokenCount: 0,
          hadError: false,
          errorMessage: null,
          createdAt: new Date().toISOString(),
        })),
      },
      memoryService: {
        recallDetailed: vi.fn(async () => ({ context: longText, matches: [] })),
      },
      messageRepository: {
        listMessages: vi.fn(() => [makeMessage(1, longText)]),
      },
    });

    const result = await service.retrieve({
      userId: 'user-1',
      personaId: 'persona-1',
      conversationId: 'conv-1',
      query: 'q',
    });

    expect(result.tokenCount).toBeLessThanOrEqual(80);
    expect(result.context.length).toBeGreaterThan(0);
  });

  it('triggers recall probe when query mentions known counterpart name', async () => {
    const service = new KnowledgeRetrievalService({
      maxContextTokens: 1200,
      knowledgeRepository: {
        listMeetingLedger: vi.fn(() => [
          {
            id: 'led-andreas',
            userId: 'user-1',
            personaId: 'persona-1',
            conversationId: 'conv-1',
            topicKey: 'meeting-andreas',
            counterpart: 'Andreas',
            eventAt: '2025-08-11T09:00:00.000Z',
            participants: [],
            decisions: [],
            negotiatedTerms: [],
            openPoints: [],
            actionItems: [],
            sourceRefs: [],
            confidence: 0.8,
            updatedAt: '2025-08-11T10:00:00.000Z',
          },
        ]),
        listEpisodes: vi.fn(() => []),
        insertRetrievalAudit: vi.fn(() => {
          throw new Error('should not be called');
        }),
      },
      memoryService: {
        recallDetailed: vi.fn(async () => ({ context: '', matches: [] })),
      },
      messageRepository: {
        listMessages: vi.fn(() => []),
      },
    });

    const shouldRecall = await service.shouldTriggerRecall({
      userId: 'user-1',
      personaId: 'persona-1',
      query: 'Was hat Andreas dazu gesagt?',
    });

    expect(shouldRecall).toBe(true);
  });

  it('triggers recall probe for rules questions without counterpart mention', async () => {
    const service = new KnowledgeRetrievalService({
      maxContextTokens: 1200,
      knowledgeRepository: {
        listMeetingLedger: vi.fn(() => []),
        listEpisodes: vi.fn(() => []),
        insertRetrievalAudit: vi.fn(() => {
          throw new Error('not used');
        }),
      },
      memoryService: {
        recallDetailed: vi.fn(async () => ({ context: '', matches: [] })),
      },
      messageRepository: {
        listMessages: vi.fn(() => []),
      },
    });

    const shouldRecall = await service.shouldTriggerRecall({
      userId: 'user-1',
      personaId: 'persona-1',
      query: 'Was sind die Regeln?',
    });

    expect(shouldRecall).toBe(true);
  });

  it('triggers recall probe for imperative rules request without question mark', async () => {
    const service = new KnowledgeRetrievalService({
      maxContextTokens: 1200,
      knowledgeRepository: {
        listMeetingLedger: vi.fn(() => []),
        listEpisodes: vi.fn(() => []),
        insertRetrievalAudit: vi.fn(() => {
          throw new Error('not used');
        }),
      },
      memoryService: {
        recallDetailed: vi.fn(async () => ({ context: '', matches: [] })),
      },
      messageRepository: {
        listMessages: vi.fn(() => []),
      },
    });

    const shouldRecall = await service.shouldTriggerRecall({
      userId: 'user-1',
      personaId: 'persona-1',
      query: 'Nenne mir die Regeln',
    });

    expect(shouldRecall).toBe(true);
  });

  it('focuses retrieval on mentioned counterpart even without "mit <name>" phrase', async () => {
    const service = new KnowledgeRetrievalService({
      maxContextTokens: 1200,
      knowledgeRepository: {
        listMeetingLedger: vi.fn(() => [
          {
            id: 'led-andreas',
            userId: 'user-1',
            personaId: 'persona-1',
            conversationId: 'conv-1',
            topicKey: 'meeting-andreas',
            counterpart: 'Andreas',
            eventAt: '2025-08-11T09:00:00.000Z',
            participants: ['Ich', 'Andreas'],
            decisions: ['Andreas: Rabatt auf 8% bestätigt'],
            negotiatedTerms: [],
            openPoints: [],
            actionItems: [],
            sourceRefs: [{ seq: 2, quote: '8 Prozent Rabatt' }],
            confidence: 0.9,
            updatedAt: '2025-08-11T10:00:00.000Z',
          },
          {
            id: 'led-bernd',
            userId: 'user-1',
            personaId: 'persona-1',
            conversationId: 'conv-1',
            topicKey: 'meeting-bernd',
            counterpart: 'Bernd',
            eventAt: '2025-08-12T09:00:00.000Z',
            participants: ['Ich', 'Bernd'],
            decisions: ['Bernd: Liefertermin verschoben'],
            negotiatedTerms: [],
            openPoints: [],
            actionItems: [],
            sourceRefs: [{ seq: 4, quote: 'Liefertermin spaeter' }],
            confidence: 0.8,
            updatedAt: '2025-08-12T10:00:00.000Z',
          },
        ]),
        listEpisodes: vi.fn(() => [
          {
            id: 'ep-andreas',
            userId: 'user-1',
            personaId: 'persona-1',
            conversationId: 'conv-1',
            topicKey: 'meeting-andreas',
            counterpart: 'Andreas',
            teaser: 'Andreas-Teaser',
            episode: 'Andreas-Episode',
            facts: ['8% Rabatt'],
            sourceSeqStart: 1,
            sourceSeqEnd: 3,
            sourceRefs: [{ seq: 2, quote: '8 Prozent Rabatt' }],
            eventAt: '2025-08-11T09:00:00.000Z',
            updatedAt: '2025-08-11T10:00:00.000Z',
          },
          {
            id: 'ep-bernd',
            userId: 'user-1',
            personaId: 'persona-1',
            conversationId: 'conv-1',
            topicKey: 'meeting-bernd',
            counterpart: 'Bernd',
            teaser: 'Bernd-Teaser',
            episode: 'Bernd-Episode',
            facts: ['Liefertermin spaeter'],
            sourceSeqStart: 4,
            sourceSeqEnd: 6,
            sourceRefs: [{ seq: 4, quote: 'Liefertermin spaeter' }],
            eventAt: '2025-08-12T09:00:00.000Z',
            updatedAt: '2025-08-12T10:00:00.000Z',
          },
        ]),
        insertRetrievalAudit: vi.fn(() => ({
          id: 'audit-1',
          userId: 'user-1',
          personaId: 'persona-1',
          conversationId: 'conv-1',
          query: 'q',
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
        listMessages: vi.fn(() => [makeMessage(2, 'Wir vereinbaren 8% Rabatt')]),
      },
    });

    const result = await service.retrieve({
      userId: 'user-1',
      personaId: 'persona-1',
      conversationId: 'conv-1',
      query: 'Was hat Andreas dazu gesagt?',
    });

    expect(result.sections.answerDraft).toContain('Meeting mit Andreas');
    expect(result.sections.keyDecisions).toContain('Andreas: Rabatt auf 8% bestätigt');
    expect(result.sections.keyDecisions).not.toContain('Bernd: Liefertermin verschoben');
  });

  it('focuses rules queries on rule-like statements and suppresses noisy context', async () => {
    const service = new KnowledgeRetrievalService({
      maxContextTokens: 1200,
      knowledgeRepository: {
        listMeetingLedger: vi.fn(() => [
          {
            id: 'led-rules',
            userId: 'user-1',
            personaId: 'persona-1',
            conversationId: 'conv-1',
            topicKey: 'office-rules',
            counterpart: null,
            eventAt: '2025-08-11T09:00:00.000Z',
            participants: [],
            decisions: ['1. Niemals zu spät kommen. Arbeitsbeginn 8 Uhr.'],
            negotiatedTerms: [],
            openPoints: ['Meeting-Outfit vorher abstimmen.'],
            actionItems: [],
            sourceRefs: [{ seq: 2, quote: 'Niemals zu spät kommen' }],
            confidence: 0.9,
            updatedAt: '2025-08-11T10:00:00.000Z',
          },
        ]),
        listEpisodes: vi.fn(() => [
          {
            id: 'ep-noisy',
            userId: 'user-1',
            personaId: 'persona-1',
            conversationId: 'conv-1',
            topicKey: 'sauna-talk',
            counterpart: null,
            teaser: 'Langer Sauna-Kontext ohne klare Regel.',
            episode: 'Wir reden viel ueber Sauna und Tagesablauf.',
            facts: ['Sauna war entspannend'],
            sourceSeqStart: 1,
            sourceSeqEnd: 5,
            sourceRefs: [{ seq: 3, quote: 'Sauna' }],
            eventAt: '2025-08-11T09:00:00.000Z',
            updatedAt: '2025-08-11T10:00:00.000Z',
          },
        ]),
        insertRetrievalAudit: vi.fn(() => ({
          id: 'audit-rules',
          userId: 'user-1',
          personaId: 'persona-1',
          conversationId: 'conv-1',
          query: 'Nenne mir die Regeln',
          stageStats: {},
          tokenCount: 0,
          hadError: false,
          errorMessage: null,
          createdAt: new Date().toISOString(),
        })),
      },
      memoryService: {
        recallDetailed: vi.fn(async () => ({
          context: '',
          matches: [
            { node: { id: 'mem-noise', content: 'Langer Sauna-Absatz ohne verbindliche Vorgaben.' } },
            {
              node: {
                id: 'mem-rule',
                content:
                  'Regeln: 1. Niemals zu spaet kommen. 2. Bei Meetings immer in der Naehe bleiben.',
              },
            },
          ],
        })),
      },
      messageRepository: {
        listMessages: vi.fn(() => [makeMessage(2, 'Niemals zu spät kommen')]),
      },
    });

    const result = await service.retrieve({
      userId: 'user-1',
      personaId: 'persona-1',
      conversationId: 'conv-1',
      query: 'Nenne mir die Regeln',
    });

    expect(result.sections.answerDraft).toContain('Kontext: Regelwissen aus Historie.');
    expect(result.sections.answerDraft).toContain('Niemals zu spät kommen');
    expect(result.sections.answerDraft).not.toContain('Sauna-Absatz');
    expect(result.sections.keyDecisions).toContain('Niemals zu spät kommen');
  });
});
