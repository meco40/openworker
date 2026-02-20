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

function buildExtraction(topicKey = 'meeting-andreas'): KnowledgeExtractionResult {
  return {
    facts: ['8% Rabatt vereinbart', 'SLA bleibt offen'],
    teaser: Array.from({ length: 90 }, (_, idx) => `teaser${idx + 1}`).join(' '),
    episode: Array.from({ length: 450 }, (_, idx) => `episode${idx + 1}`).join(' '),
    entities: [],
    events: [],
    meetingLedger: {
      topicKey,
      counterpart: 'Andreas',
      participants: ['Ich', 'Andreas'],
      decisions: ['8% Rabatt beschlossen'],
      negotiatedTerms: ['8% Rabatt fuer 12 Monate'],
      openPoints: ['SLA Abnahme'],
      actionItems: ['Andreas sendet Vertragsentwurf'],
      sourceRefs: [{ seq: 2, quote: 'wir einigen uns auf 8 Prozent Rabatt' }],
      confidence: 0.88,
    },
  };
}

describe('KnowledgeIngestionService', () => {
  it('processes windows, writes artifacts, stores semantic memories and updates checkpoint', async () => {
    const window: IngestionWindow = {
      conversationId: 'conv-1',
      userId: 'user-1',
      personaId: 'persona-1',
      fromSeqExclusive: 0,
      toSeqInclusive: 3,
      messages: [
        createMessage(1, 'conv-1', 'Meeting mit Andreas'),
        createMessage(2, 'conv-1', '8% Rabatt ausgehandelt'),
        createMessage(3, 'conv-1', 'SLA bleibt offen'),
      ],
    };

    const getPendingWindows = vi.fn(() => [window]);
    const markWindowProcessed = vi.fn();
    const extract = vi.fn(async () => buildExtraction());
    const upsertEpisode = vi.fn();
    const upsertMeetingLedger = vi.fn();
    const store = vi.fn(async () => ({ id: 'mem-1' }));

    const service = new KnowledgeIngestionService({
      cursor: { getPendingWindows, markWindowProcessed },
      extractor: { extract },
      knowledgeRepository: {
        upsertEpisode,
        upsertMeetingLedger,
      },
      memoryService: { store },
    });

    const result = await service.runOnce();

    expect(result.processedConversations).toBe(1);
    expect(result.processedMessages).toBe(3);
    expect(result.errors).toHaveLength(0);

    expect(extract).toHaveBeenCalledTimes(1);
    expect(upsertEpisode).toHaveBeenCalledTimes(1);
    expect(upsertMeetingLedger).toHaveBeenCalledTimes(1);
    expect(store).toHaveBeenCalled();
    expect(markWindowProcessed).toHaveBeenCalledWith(window);

    const episodeCall = upsertEpisode.mock.calls[0][0] as Record<string, unknown>;
    expect(episodeCall.topicKey).toBe('meeting-andreas');
    expect(episodeCall.sourceSeqStart).toBe(1);
    expect(episodeCall.sourceSeqEnd).toBe(3);
  });

  it('continues with other conversations when one extraction fails and is retry-safe', async () => {
    const windows: IngestionWindow[] = [
      {
        conversationId: 'conv-error',
        userId: 'user-1',
        personaId: 'persona-1',
        fromSeqExclusive: 0,
        toSeqInclusive: 2,
        messages: [createMessage(1, 'conv-error', 'bad'), createMessage(2, 'conv-error', 'bad2')],
      },
      {
        conversationId: 'conv-ok',
        userId: 'user-1',
        personaId: 'persona-1',
        fromSeqExclusive: 0,
        toSeqInclusive: 2,
        messages: [createMessage(1, 'conv-ok', 'good'), createMessage(2, 'conv-ok', 'good2')],
      },
    ];

    let emitted = false;
    const processedConversationIds = new Set<string>();

    const cursor = {
      getPendingWindows: vi.fn(() => {
        if (emitted) return [];
        emitted = true;
        return windows.filter((window) => !processedConversationIds.has(window.conversationId));
      }),
      markWindowProcessed: vi.fn((window: IngestionWindow) => {
        processedConversationIds.add(window.conversationId);
      }),
    };

    const extract = vi.fn(async (input: { conversationId: string }) => {
      if (input.conversationId === 'conv-error') {
        throw new Error('extract failed');
      }
      return buildExtraction('meeting-ok');
    });

    const service = new KnowledgeIngestionService({
      cursor,
      extractor: { extract },
      knowledgeRepository: {
        upsertEpisode: vi.fn(),
        upsertMeetingLedger: vi.fn(),
      },
      memoryService: {
        store: vi.fn(async () => ({ id: 'mem-x' })),
      },
    });

    const result = await service.runOnce();

    expect(result.processedConversations).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].conversationId).toBe('conv-error');
    expect(cursor.markWindowProcessed).toHaveBeenCalledTimes(1);

    const second = await service.runOnce();
    expect(second.processedConversations).toBe(0);
  });

  it('stores only meaningful fact artifacts in memory (no command/greeting noise, no teaser/episode)', async () => {
    const window: IngestionWindow = {
      conversationId: 'conv-meaningful',
      userId: 'user-1',
      personaId: 'persona-1',
      fromSeqExclusive: 0,
      toSeqInclusive: 4,
      messages: [
        createMessage(1, 'conv-meaningful', '/new'),
        createMessage(2, 'conv-meaningful', 'Neue Konversation erstellt.'),
        createMessage(3, 'conv-meaningful', 'Hallo'),
        createMessage(
          4,
          'conv-meaningful',
          'Regeln: 1. Niemals zu spät kommen. 2. Bei Meetings bleibst du in meiner Nähe.',
        ),
      ],
    };

    const extract = vi.fn(
      async (): Promise<KnowledgeExtractionResult> => ({
        facts: [
          '/new',
          'Neue Konversation erstellt.',
          'Hallo',
          'Regeln: 1. Niemals zu spät kommen. 2. Bei Meetings bleibst du in meiner Nähe.',
        ],
        teaser: 'Kurztext mit Kontext',
        episode: 'Langer Episodentext mit vielen Details',
        entities: [],
        events: [],
        meetingLedger: {
          topicKey: 'office-rules',
          counterpart: null,
          participants: ['Ich'],
          decisions: [],
          negotiatedTerms: [],
          openPoints: [],
          actionItems: [],
          sourceRefs: [{ seq: 4, quote: 'Regeln: 1. Niemals zu spät kommen.' }],
          confidence: 0.7,
        },
      }),
    );
    const store = vi.fn(async () => ({ id: 'mem-1' }));

    const service = new KnowledgeIngestionService({
      cursor: {
        getPendingWindows: vi.fn(() => [window]),
        markWindowProcessed: vi.fn(),
      },
      extractor: { extract },
      knowledgeRepository: {
        upsertEpisode: vi.fn(),
        upsertMeetingLedger: vi.fn(),
      },
      memoryService: { store },
    });

    await service.runOnce();

    const storedPayloads = (store.mock.calls as unknown[][]).map((call) => String(call[2] || ''));
    expect(storedPayloads.some((value) => value === '/new')).toBe(false);
    expect(storedPayloads.some((value) => /neue konversation erstellt/i.test(value))).toBe(false);
    expect(storedPayloads.some((value) => /^hallo$/i.test(value))).toBe(false);
    expect(storedPayloads.some((value) => /niemals zu spät kommen/i.test(value))).toBe(true);
    expect(storedPayloads.some((value) => /Kurztext mit Kontext/i.test(value))).toBe(false);
    expect(storedPayloads.some((value) => /Langer Episodentext/i.test(value))).toBe(false);
  });

  it('annotates contradiction metadata when extracted facts conflict within the same batch', async () => {
    const window: IngestionWindow = {
      conversationId: 'conv-contra',
      userId: 'user-1',
      personaId: 'persona-1',
      fromSeqExclusive: 0,
      toSeqInclusive: 3,
      messages: [
        createMessage(1, 'conv-contra', 'Max ist mein Bruder'),
        createMessage(2, 'conv-contra', 'Nein Quatsch'),
        createMessage(3, 'conv-contra', 'Max ist mein Cousin'),
      ],
    };

    const extract = vi.fn(
      async (): Promise<KnowledgeExtractionResult> => ({
        facts: ['Max ist mein Bruder', 'Max ist mein Cousin'],
        teaser: 'Korrektur zu Max',
        episode: 'Max wurde als Cousin korrigiert',
        entities: [],
        events: [],
        meetingLedger: {
          topicKey: 'family',
          counterpart: null,
          participants: ['Ich'],
          decisions: [],
          negotiatedTerms: [],
          openPoints: [],
          actionItems: [],
          sourceRefs: [],
          confidence: 0.7,
        },
      }),
    );
    const store = vi.fn(async () => ({ id: 'mem-store' }));

    const service = new KnowledgeIngestionService({
      cursor: {
        getPendingWindows: vi.fn(() => [window]),
        markWindowProcessed: vi.fn(),
      },
      extractor: { extract },
      knowledgeRepository: {
        upsertEpisode: vi.fn(),
        upsertMeetingLedger: vi.fn(),
      },
      memoryService: { store },
    });

    await service.runOnce();

    // The second fact ("Max ist mein Cousin") should have contradiction metadata
    const metadataCalls = (store.mock.calls as unknown[][]).map(
      (call) => call[5] as Record<string, unknown>,
    );

    // We expect the later fact to annotate the contradiction
    const lastCall = metadataCalls[metadataCalls.length - 1];
    expect(lastCall).toBeDefined();
    expect(lastCall!.contradictionDetected).toBe(true);
    expect(lastCall!.contradictionType).toBe('value_change');
    expect(lastCall!.supersedes).toBe('Max ist mein Bruder');
  });

  it('skips direct ingestion when delta is below configured minimum batch size', async () => {
    const extract = vi.fn(async () => buildExtraction());
    const upsertCheckpoint = vi.fn();

    const service = new KnowledgeIngestionService(
      {
        cursor: {
          getPendingWindows: vi.fn(() => []),
          markWindowProcessed: vi.fn(),
        },
        extractor: { extract },
        knowledgeRepository: {
          getIngestionCheckpoint: vi.fn(() => ({
            conversationId: 'conv-threshold',
            personaId: 'persona-1',
            lastSeq: 0,
            updatedAt: new Date().toISOString(),
          })),
          upsertIngestionCheckpoint: upsertCheckpoint,
          upsertEpisode: vi.fn(),
          upsertMeetingLedger: vi.fn(),
        },
        memoryService: { store: vi.fn(async () => ({ id: 'mem-1' })) },
      },
      {
        minMessagesPerBatch: 50,
      },
    );

    const messages = Array.from({ length: 40 }, (_, idx) =>
      createMessage(idx + 1, 'conv-threshold', `Nachricht ${idx + 1}`),
    );

    await service.ingestConversationWindow({
      conversationId: 'conv-threshold',
      userId: 'user-1',
      personaId: 'persona-1',
      messages,
    });

    expect(extract).not.toHaveBeenCalled();
    expect(upsertCheckpoint).not.toHaveBeenCalled();
  });
});
