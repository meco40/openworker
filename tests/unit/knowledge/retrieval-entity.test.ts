import { describe, expect, it, vi } from 'vitest';
import type { StoredMessage } from '@/server/channels/messages/repository';
import { KnowledgeRetrievalService } from '@/server/knowledge/retrieval';

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

const BASE_AUDIT = {
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
};

describe('Entity-Graph integration in retrieval', () => {
  it('resolves alias "Bruder" to entity Max for count queries', async () => {
    const countUniqueDaysMock = vi.fn((_filter: unknown) => ({
      uniqueDayCount: 3,
      uniqueDays: ['2026-01-01', '2026-01-15', '2026-02-01'],
      eventCount: 3,
      events: [],
    }));

    const resolveEntityMock = vi.fn((text: string) => {
      if (text === 'bruder') {
        return {
          entity: {
            id: 'ent-max',
            userId: 'user-1',
            personaId: 'persona-1',
            canonicalName: 'Max',
            category: 'person' as const,
            owner: 'persona' as const,
            properties: {},
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
          },
          matchedAlias: 'Bruder',
          matchType: 'alias' as const,
          confidence: 0.9,
        };
      }
      return null;
    });

    const getEntityWithRelationsMock = vi.fn(() => ({
      entity: {
        id: 'ent-max',
        userId: 'user-1',
        personaId: 'persona-1',
        canonicalName: 'Max',
        category: 'person' as const,
        owner: 'persona' as const,
        properties: {},
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
      aliases: [
        {
          id: 'alias-1',
          entityId: 'ent-max',
          alias: 'Bruder',
          aliasType: 'relation' as const,
          owner: 'persona' as const,
          confidence: 0.9,
          createdAt: '2026-01-01T00:00:00Z',
        },
      ],
      relations: [],
    }));

    const service = new KnowledgeRetrievalService({
      maxContextTokens: 1200,
      knowledgeRepository: {
        listMeetingLedger: vi.fn(() => []),
        listEpisodes: vi.fn(() => []),
        insertRetrievalAudit: vi.fn(() => BASE_AUDIT),
        countUniqueDays: countUniqueDaysMock,
        resolveEntity: resolveEntityMock,
        getEntityWithRelations: getEntityWithRelationsMock,
        getRelatedEntities: vi.fn(() => []),
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
      query: 'Wie oft mit Bruder geschlafen?',
    });

    // resolveEntity was called with lowered "bruder"
    expect(resolveEntityMock).toHaveBeenCalledWith('bruder', {
      userId: 'user-1',
      personaId: 'persona-1',
    });

    // countUniqueDays was called with canonical name "Max", not "bruder"
    expect(countUniqueDaysMock).toHaveBeenCalledTimes(1);
    const filterArg = countUniqueDaysMock.mock.calls[0]?.[0] as
      | { counterpartEntity?: string; eventType?: string }
      | undefined;
    if (!filterArg) throw new Error('countUniqueDays was not called with a filter');
    expect(filterArg.counterpartEntity).toBe('Max');
    expect(filterArg.eventType).toBe('shared_sleep');

    // Computed answer references "Max"
    expect(result.computedAnswer).toBeTruthy();
    expect(result.computedAnswer).toContain('3 Tage');
    expect(result.computedAnswer).toContain('Max');
  });

  it('injects project entity context for general recall queries', async () => {
    const resolveEntityMock = vi.fn((text: string) => {
      if (text === 'notes2') {
        return {
          entity: {
            id: 'ent-notes2',
            userId: 'user-1',
            personaId: 'persona-1',
            canonicalName: 'Notes2',
            category: 'project' as const,
            owner: 'shared' as const,
            properties: {},
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
          },
          matchedAlias: 'Notes2',
          matchType: 'exact_name' as const,
          confidence: 1.0,
        };
      }
      return null;
    });

    const getEntityWithRelationsMock = vi.fn(() => ({
      entity: {
        id: 'ent-notes2',
        userId: 'user-1',
        personaId: 'persona-1',
        canonicalName: 'Notes2',
        category: 'project' as const,
        owner: 'shared' as const,
        properties: {},
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
      aliases: [],
      relations: [
        {
          id: 'rel-1',
          sourceEntityId: 'ent-notes2',
          targetEntityId: 'ent-nextjs',
          relationType: 'framework',
          properties: {},
          confidence: 0.95,
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
        {
          id: 'rel-2',
          sourceEntityId: 'ent-notes2',
          targetEntityId: 'ent-prisma',
          relationType: 'orm',
          properties: {},
          confidence: 0.9,
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ],
    }));

    const getRelatedEntitiesMock = vi.fn(() => [
      {
        id: 'ent-nextjs',
        userId: 'user-1',
        personaId: 'persona-1',
        canonicalName: 'Next.js',
        category: 'concept' as const,
        owner: 'shared' as const,
        properties: {},
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
      {
        id: 'ent-prisma',
        userId: 'user-1',
        personaId: 'persona-1',
        canonicalName: 'Prisma',
        category: 'concept' as const,
        owner: 'shared' as const,
        properties: {},
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ]);

    const service = new KnowledgeRetrievalService({
      maxContextTokens: 1200,
      knowledgeRepository: {
        listMeetingLedger: vi.fn(() => []),
        listEpisodes: vi.fn(() => [
          {
            id: 'ep-notes',
            userId: 'user-1',
            personaId: 'persona-1',
            conversationId: 'conv-1',
            topicKey: 'notes2',
            counterpart: null,
            teaser: 'Notes2 Projektbesprechung',
            episode: 'Wir bauen Notes2 mit Next.js und Prisma.',
            facts: ['Next.js als Framework', 'Prisma als ORM'],
            sourceSeqStart: 1,
            sourceSeqEnd: 5,
            sourceRefs: [{ seq: 2, quote: 'Next.js und Prisma' }],
            eventAt: '2026-02-01T09:00:00Z',
            updatedAt: '2026-02-01T10:00:00Z',
          },
        ]),
        insertRetrievalAudit: vi.fn(() => BASE_AUDIT),
        resolveEntity: resolveEntityMock,
        getEntityWithRelations: getEntityWithRelationsMock,
        getRelatedEntities: getRelatedEntitiesMock,
      },
      memoryService: {
        recallDetailed: vi.fn(async () => ({
          context: 'Notes2 ist ein Projekt mit Next.js',
          matches: [{ node: { id: 'mem-1', content: 'Notes2 Projekt' } }],
        })),
      },
      messageRepository: {
        listMessages: vi.fn(() => [makeMessage(2, 'Wir nutzen Next.js fuer Notes2')]),
      },
    });

    const result = await service.retrieve({
      userId: 'user-1',
      personaId: 'persona-1',
      conversationId: 'conv-1',
      query: 'Was weisst du ueber Notes2?',
    });

    // Entity context should contain project graph with framework and orm
    expect(result.sections.answerDraft).toContain('Entity-Kontext');
    expect(result.sections.answerDraft).toContain('Notes2');
    expect(result.sections.answerDraft).toContain('framework');
    expect(result.sections.answerDraft).toContain('Next.js');
    expect(result.sections.answerDraft).toContain('orm');
    expect(result.sections.answerDraft).toContain('Prisma');
  });

  it('passes correct userId and personaId filter to resolveEntity', async () => {
    const resolveEntityMock = vi.fn(() => null);

    const service = new KnowledgeRetrievalService({
      maxContextTokens: 1200,
      knowledgeRepository: {
        listMeetingLedger: vi.fn(() => []),
        listEpisodes: vi.fn(() => []),
        insertRetrievalAudit: vi.fn(() => BASE_AUDIT),
        resolveEntity: resolveEntityMock,
        getEntityWithRelations: vi.fn(() => ({
          entity: {} as never,
          aliases: [],
          relations: [],
        })),
        getRelatedEntities: vi.fn(() => []),
      },
      memoryService: {
        recallDetailed: vi.fn(async () => ({ context: '', matches: [] })),
      },
      messageRepository: {
        listMessages: vi.fn(() => []),
      },
    });

    await service.retrieve({
      userId: 'user-42',
      personaId: 'persona-7',
      conversationId: 'conv-1',
      query: 'Wie oft mit Lisa geschlafen?',
    });

    // resolveEntity should be called with the user's scope
    expect(resolveEntityMock).toHaveBeenCalledWith('lisa', {
      userId: 'user-42',
      personaId: 'persona-7',
    });
  });
});
