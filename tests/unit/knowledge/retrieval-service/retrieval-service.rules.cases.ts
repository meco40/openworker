import { describe, expect, it, vi } from 'vitest';
import { KnowledgeRetrievalService } from '@/server/knowledge/retrieval';
import { makeMessage } from './retrieval-service.harness';

describe('KnowledgeRetrievalService', () => {
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
            {
              node: { id: 'mem-noise', content: 'Langer Sauna-Absatz ohne verbindliche Vorgaben.' },
            },
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

  it('falls back to entity properties and matching events for rules retrieval', async () => {
    const service = new KnowledgeRetrievalService({
      maxContextTokens: 1200,
      knowledgeRepository: {
        listMeetingLedger: vi.fn(() => []),
        listEpisodes: vi.fn(() => []),
        listEntities: vi.fn(() => [
          {
            id: 'ent-rules',
            userId: 'user-1',
            personaId: 'persona-1',
            canonicalName: 'Arbeitsregeln',
            category: 'concept' as const,
            owner: 'shared' as const,
            properties: {
              rules:
                'Regeln: 1. Arbeitsbeginn ist 08:00 Uhr. 2. Im Meeting bleibt das Handy lautlos.',
            },
            createdAt: '2026-02-20T09:00:00.000Z',
            updatedAt: '2026-02-20T09:00:00.000Z',
          },
        ]),
        listEvents: vi.fn(() => [
          {
            id: 'evt-rules-1',
            userId: 'user-1',
            personaId: 'persona-1',
            conversationId: 'conv-1',
            eventType: 'meeting',
            speakerRole: 'user' as const,
            speakerEntity: 'User',
            subjectEntity: 'Arbeitsregeln',
            counterpartEntity: 'Nata',
            relationLabel: null,
            startDate: '2026-02-20',
            endDate: '2026-02-20',
            dayCount: 1,
            sourceSeqJson: '[11,12]',
            sourceSummary:
              'Regeln: 1. Arbeitsbeginn ist 08:00 Uhr. 2. Im Meeting bleibt das Handy lautlos.',
            isConfirmation: false,
            confidence: 0.9,
            createdAt: '2026-02-20T09:00:00.000Z',
            updatedAt: '2026-02-20T09:00:00.000Z',
          },
        ]),
        insertRetrievalAudit: vi.fn(() => ({
          id: 'audit-rules-fallback',
          userId: 'user-1',
          personaId: 'persona-1',
          conversationId: 'conv-1',
          query: 'Was sind die Regeln auf der Arbeit?',
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
          makeMessage(11, 'Arbeitsbeginn ist 08:00 Uhr.'),
          makeMessage(12, 'Im Meeting bleibt das Handy lautlos.'),
        ]),
      },
    });

    const result = await service.retrieve({
      userId: 'user-1',
      personaId: 'persona-1',
      conversationId: 'conv-1',
      query: 'Was sind die Regeln auf der Arbeit?',
    });

    expect(result.sections.answerDraft).toContain('Arbeitsbeginn ist 08:00 Uhr');
    expect(result.sections.answerDraft).toContain('Handy lautlos');
    expect(result.references).toContain('seq:11');
    expect(result.sections.evidence).toContain('[seq:11]');
  });

  it('returns "unklar" for rules queries when no evidence refs exist', async () => {
    const service = new KnowledgeRetrievalService({
      maxContextTokens: 1200,
      knowledgeRepository: {
        listMeetingLedger: vi.fn(() => [
          {
            id: 'led-no-refs',
            userId: 'user-1',
            personaId: 'persona-1',
            conversationId: 'conv-1',
            topicKey: 'office-rules',
            counterpart: null,
            eventAt: '2025-08-11T09:00:00.000Z',
            participants: [],
            decisions: ['Regel: Arbeitsbeginn ist 08:00 Uhr.'],
            negotiatedTerms: [],
            openPoints: [],
            actionItems: [],
            sourceRefs: [],
            confidence: 0.9,
            updatedAt: '2025-08-11T10:00:00.000Z',
          },
        ]),
        listEpisodes: vi.fn(() => []),
        listEntities: vi.fn(() => []),
        listEvents: vi.fn(() => []),
        insertRetrievalAudit: vi.fn(() => ({
          id: 'audit-rules-unclear',
          userId: 'user-1',
          personaId: 'persona-1',
          conversationId: 'conv-1',
          query: 'Was sind die Regeln?',
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
        listMessages: vi.fn(() => [makeMessage(1, 'Hallo')]),
      },
    });

    const result = await service.retrieve({
      userId: 'user-1',
      personaId: 'persona-1',
      conversationId: 'conv-1',
      query: 'Was sind die Regeln?',
    });

    expect(result.references).toHaveLength(0);
    expect(result.sections.answerDraft.toLowerCase()).toContain('unklar');
    expect(result.sections.answerDraft).not.toContain('Arbeitsbeginn ist 08:00 Uhr');
  });
});
