import { describe, expect, it, vi } from 'vitest';
import { KnowledgeRetrievalService } from '@/server/knowledge/retrieval';

describe('KnowledgeRetrievalService', () => {
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
});
