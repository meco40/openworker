import { describe, expect, it } from 'vitest';
import type { StoredMessage } from '@/server/channels/messages/repository';
import type { KnowledgeExtractionResult } from '@/server/knowledge/extractor';
import type { IngestionWindow } from '@/server/knowledge/ingestionCursor';
import { KnowledgeIngestionService } from '@/server/knowledge/ingestion/service';
import { SqliteKnowledgeRepository } from '@/server/knowledge/sqliteKnowledgeRepository';
import { MemoryService } from '@/server/memory/service';
import { SqliteMemoryClient } from '@/server/memory/sqliteMemoryClient';
import { SqliteMemoryRepository } from '@/server/memory/sqliteMemoryRepository';

function message(seq: number, role: 'user' | 'agent', content: string): StoredMessage {
  return {
    id: `pipeline-msg-${seq}`,
    conversationId: 'conversation-pipeline',
    seq,
    role,
    content,
    platform: 'WebChat' as never,
    externalMsgId: null,
    senderName: null,
    metadata: null,
    createdAt: `2026-08-18T10:0${seq}:00.000Z`,
  };
}

function extraction(): KnowledgeExtractionResult {
  return {
    facts: ['Alice prefers coffee', 'The SLA remains open'],
    teaser: 'A coffee preference and an open SLA were captured.',
    episode: 'The conversation captured a preference and an unresolved contract point.',
    entities: [],
    events: [],
    meetingLedger: {
      topicKey: 'contract',
      counterpart: 'Alice',
      participants: ['Ich', 'Alice'],
      decisions: [],
      negotiatedTerms: [],
      openPoints: ['The SLA remains open'],
      actionItems: [],
      sourceRefs: [{ seq: 2, quote: 'The SLA remains open' }],
      confidence: 0.9,
    },
  };
}

describe('knowledge ingestion pipeline', () => {
  it('persists LLM extraction through Memory and Knowledge stores idempotently', async () => {
    const knowledgeRepository = new SqliteKnowledgeRepository(':memory:');
    const memoryService = new MemoryService(
      new SqliteMemoryClient(new SqliteMemoryRepository(':memory:')),
    );
    const window: IngestionWindow = {
      conversationId: 'conversation-pipeline',
      userId: 'user-pipeline',
      personaId: 'persona-pipeline',
      fromSeqExclusive: 0,
      toSeqInclusive: 3,
      messages: [
        message(1, 'user', 'We discussed the contract.'),
        message(2, 'agent', 'The SLA remains open.'),
        message(3, 'user', 'Alice prefers coffee.'),
      ],
    };
    let runs = 0;
    const service = new KnowledgeIngestionService({
      cursor: {
        getPendingWindows: () => (runs++ < 2 ? [window] : []),
        markWindowProcessed: () => {},
      },
      extractor: { extract: async () => extraction() },
      knowledgeRepository,
      memoryService,
    });

    expect((await service.runOnce()).errors).toHaveLength(0);
    expect((await service.runOnce()).errors).toHaveLength(0);

    const episodes = knowledgeRepository.listEpisodes({
      userId: 'user-pipeline',
      personaId: 'persona-pipeline',
    });
    const memories = await memoryService.snapshot('persona-pipeline', 'user-pipeline');
    expect(episodes).toHaveLength(1);
    expect(episodes[0].memoryIds?.length).toBe(2);
    expect(memories).toHaveLength(2);
    expect(new Set(memories.map((memory) => memory.metadata?.idempotencyKey)).size).toBe(2);
  });
});
