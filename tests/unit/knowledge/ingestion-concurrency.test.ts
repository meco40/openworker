import { describe, expect, it, vi } from 'vitest';
import type { StoredMessage } from '@/server/channels/messages/repository';
import type { KnowledgeExtractionResult } from '@/server/knowledge/extractor';
import type { IngestionWindow } from '@/server/knowledge/ingestionCursor';
import { KnowledgeIngestionService } from '@/server/knowledge/ingestionService';

function createMessage(seq: number, conversationId: string, content: string): StoredMessage {
  return {
    id: `msg-${conversationId}-${seq}`,
    conversationId,
    seq,
    role: seq % 2 === 0 ? 'agent' : 'user',
    content,
    platform: 'WebChat' as never,
    externalMsgId: null,
    senderName: null,
    metadata: null,
    createdAt: new Date(2025, 1, 1, 9, seq).toISOString(),
  };
}

describe('KnowledgeIngestionService fact store concurrency', () => {
  it('stores facts sequentially — never more than one in-flight mem0 call at a time', async () => {
    const window: IngestionWindow = {
      conversationId: 'conv-batch',
      userId: 'user-1',
      personaId: 'persona-1',
      fromSeqExclusive: 0,
      toSeqInclusive: 3,
      messages: [
        createMessage(1, 'conv-batch', 'Meeting mit Sarah'),
        createMessage(2, 'conv-batch', '10% Rabatt vereinbart'),
        createMessage(3, 'conv-batch', 'Deadline Freitag'),
      ],
    };

    let concurrentCalls = 0;
    let maxConcurrentCalls = 0;

    const store = vi.fn(async () => {
      concurrentCalls += 1;
      maxConcurrentCalls = Math.max(maxConcurrentCalls, concurrentCalls);
      // Simulate async network latency
      await new Promise((resolve) => setTimeout(resolve, 5));
      concurrentCalls -= 1;
      return { id: 'mem-1' };
    });

    const extraction: KnowledgeExtractionResult = {
      facts: [
        '10% Rabatt vereinbart',
        'Deadline Freitag',
        'Sarah als Ansprechpartnerin',
        'Vertrag bis Ende Monat',
      ],
      teaser: Array.from({ length: 90 }, (_, idx) => `t${idx + 1}`).join(' '),
      episode: Array.from({ length: 450 }, (_, idx) => `e${idx + 1}`).join(' '),
      entities: [],
      events: [],
      meetingLedger: {
        topicKey: 'meeting-sarah',
        counterpart: 'Sarah',
        participants: ['Ich', 'Sarah'],
        decisions: ['10% Rabatt beschlossen'],
        negotiatedTerms: ['10% Rabatt'],
        openPoints: ['Deadline'],
        actionItems: ['Vertrag senden'],
        sourceRefs: [{ seq: 2, quote: '10% Rabatt vereinbart' }],
        confidence: 0.85,
      },
    };

    const service = new KnowledgeIngestionService({
      cursor: {
        getPendingWindows: vi.fn(() => [window]),
        markWindowProcessed: vi.fn(),
      },
      extractor: { extract: vi.fn(async () => extraction) },
      knowledgeRepository: {
        upsertEpisode: vi.fn(),
        upsertMeetingLedger: vi.fn(),
      },
      memoryService: { store },
    });

    await service.runOnce();

    // All 4 facts should be stored
    expect(store).toHaveBeenCalledTimes(4);

    // Critical: no more than 1 in-flight store at any moment
    expect(maxConcurrentCalls).toBe(1);
  });

  it('continues storing remaining facts when one store fails transiently', async () => {
    const window: IngestionWindow = {
      conversationId: 'conv-partial',
      userId: 'user-1',
      personaId: 'persona-1',
      fromSeqExclusive: 0,
      toSeqInclusive: 2,
      messages: [
        createMessage(1, 'conv-partial', 'Fakt A vereinbart'),
        createMessage(2, 'conv-partial', 'Fakt B offen'),
      ],
    };

    let callIndex = 0;
    const store = vi.fn(async () => {
      callIndex += 1;
      if (callIndex === 2) {
        throw new Error('Mem0 request failed with HTTP 500: pool exhausted');
      }
      return { id: `mem-${callIndex}` };
    });

    const extraction: KnowledgeExtractionResult = {
      facts: ['Fakt A vereinbart', 'Fakt B offen', 'Fakt C beschlossen'],
      teaser: Array.from({ length: 90 }, (_, idx) => `t${idx + 1}`).join(' '),
      episode: Array.from({ length: 450 }, (_, idx) => `e${idx + 1}`).join(' '),
      entities: [],
      events: [],
      meetingLedger: {
        topicKey: 'general',
        counterpart: null,
        participants: ['Ich'],
        decisions: [],
        negotiatedTerms: [],
        openPoints: [],
        actionItems: [],
        sourceRefs: [],
        confidence: 0.5,
      },
    };

    const service = new KnowledgeIngestionService({
      cursor: {
        getPendingWindows: vi.fn(() => [window]),
        markWindowProcessed: vi.fn(),
      },
      extractor: { extract: vi.fn(async () => extraction) },
      knowledgeRepository: {
        upsertEpisode: vi.fn(),
        upsertMeetingLedger: vi.fn(),
      },
      memoryService: { store },
    });

    // The window-level processing should succeed even when individual stores fail.
    // A single transient Mem0 failure must not suppress all remaining facts in this window.
    const result = await service.runOnce();

    expect(store).toHaveBeenCalledTimes(3);
    // processWindow does not throw on individual store failures, so no errors
    expect(result.errors).toHaveLength(0);
  });

  it('opens mem0 circuit only after repeated consecutive failures within one window', async () => {
    const window: IngestionWindow = {
      conversationId: 'conv-circuit',
      userId: 'user-1',
      personaId: 'persona-1',
      fromSeqExclusive: 0,
      toSeqInclusive: 2,
      messages: [
        createMessage(1, 'conv-circuit', 'Fakt A vereinbart'),
        createMessage(2, 'conv-circuit', 'Fakt B offen'),
      ],
    };

    const store = vi.fn(async () => {
      throw new Error('Mem0 request timeout after 5000ms.');
    });

    const extraction: KnowledgeExtractionResult = {
      facts: ['Fakt A vereinbart', 'Fakt B offen', 'Fakt C beschlossen'],
      teaser: Array.from({ length: 90 }, (_, idx) => `t${idx + 1}`).join(' '),
      episode: Array.from({ length: 450 }, (_, idx) => `e${idx + 1}`).join(' '),
      entities: [],
      events: [],
      meetingLedger: {
        topicKey: 'general',
        counterpart: null,
        participants: ['Ich'],
        decisions: [],
        negotiatedTerms: [],
        openPoints: [],
        actionItems: [],
        sourceRefs: [],
        confidence: 0.5,
      },
    };

    const service = new KnowledgeIngestionService({
      cursor: {
        getPendingWindows: vi.fn(() => [window]),
        markWindowProcessed: vi.fn(),
      },
      extractor: { extract: vi.fn(async () => extraction) },
      knowledgeRepository: {
        upsertEpisode: vi.fn(),
        upsertMeetingLedger: vi.fn(),
      },
      memoryService: { store },
    });

    const result = await service.runOnce();

    // Two failures in a row open the circuit; third fact is skipped in this window.
    expect(store).toHaveBeenCalledTimes(2);
    expect(result.errors).toHaveLength(0);
  });
});
