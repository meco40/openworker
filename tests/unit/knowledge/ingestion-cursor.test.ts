import { describe, expect, it } from 'vitest';
import type { Conversation } from '@/shared/domain/types';
import type { MessageRepository, StoredMessage } from '@/server/channels/messages/repository';
import type { KnowledgeRepository } from '@/server/knowledge/repository';
import { KnowledgeIngestionCursor } from '@/server/knowledge/ingestionCursor';

function createMessage(seq: number, conversationId: string, content: string): StoredMessage {
  return {
    id: `msg-${seq}`,
    conversationId,
    seq,
    role: seq % 2 === 0 ? 'agent' : 'user',
    content,
    platform: 'WebChat' as never,
    externalMsgId: null,
    senderName: null,
    metadata: null,
    createdAt: new Date(2025, 0, 1, 10, seq).toISOString(),
  };
}

describe('KnowledgeIngestionCursor', () => {
  it('fetches only messages after checkpoint and stays idempotent across runs', () => {
    const conversation: Conversation = {
      id: 'conv-1',
      channelType: 'WebChat' as never,
      externalChatId: 'default',
      userId: 'user-1',
      title: 'Chat',
      modelOverride: null,
      personaId: 'persona-1',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const messages: StoredMessage[] = [
      createMessage(1, 'conv-1', 'Hallo'),
      createMessage(2, 'conv-1', 'Meeting mit Andreas'),
      createMessage(3, 'conv-1', '8% Rabatt vereinbart'),
    ];

    const checkpoints = new Map<string, number>();

    const messageRepo: MessageRepository = {
      createConversation: () => conversation,
      getConversation: () => conversation,
      getConversationByExternalChat: () => conversation,
      getOrCreateConversation: () => conversation,
      listConversations: () => [conversation],
      updateConversationTitle: () => {},
      saveMessage: () => messages[0],
      getMessage: () => null,
      listMessages: (conversationId) => messages.filter((m) => m.conversationId === conversationId),
      getDefaultWebChatConversation: () => conversation,
      deleteConversation: () => true,
      updateModelOverride: () => {},
      updatePersonaId: () => {},
      findMessageByClientId: () => null,
      getConversationContext: () => null,
      upsertConversationContext: () => ({
        conversationId: conversation.id,
        summaryText: '',
        summaryUptoSeq: 0,
        updatedAt: new Date().toISOString(),
      }),
      listMessagesAfterSeq: (conversationId, afterSeq, limit = 500) =>
        messages
          .filter((m) => m.conversationId === conversationId && Number(m.seq || 0) > afterSeq)
          .sort((a, b) => Number(a.seq || 0) - Number(b.seq || 0))
          .slice(0, limit),
    };

    const knowledgeRepo = {
      getIngestionCheckpoint: (conversationId: string, personaId: string) => {
        const key = `${conversationId}::${personaId}`;
        const seq = checkpoints.get(key);
        if (seq === undefined) return null;
        return {
          conversationId,
          personaId,
          lastSeq: seq,
          updatedAt: new Date().toISOString(),
        };
      },
      upsertIngestionCheckpoint: ({
        conversationId,
        personaId,
        lastSeq,
      }: {
        conversationId: string;
        personaId: string;
        lastSeq: number;
      }) => {
        checkpoints.set(`${conversationId}::${personaId}`, lastSeq);
        return {
          conversationId,
          personaId,
          lastSeq,
          updatedAt: new Date().toISOString(),
        };
      },
      upsertEpisode: () => {
        throw new Error('not used');
      },
      listEpisodes: () => [],
      upsertMeetingLedger: () => {
        throw new Error('not used');
      },
      listMeetingLedger: () => [],
      insertRetrievalAudit: () => {
        throw new Error('not used');
      },
      listRetrievalAudit: () => [],
      getKnowledgeStats: () => ({
        episodeCount: 0,
        ledgerCount: 0,
        retrievalErrorCount: 0,
        latestIngestionAt: null,
        ingestionLagMs: 0,
      }),
      deleteKnowledgeByScope: () => 0,
      pruneKnowledgeBefore: () => ({ episodes: 0, ledger: 0, audits: 0 }),
    } as unknown as KnowledgeRepository;

    const cursor = new KnowledgeIngestionCursor(messageRepo, knowledgeRepo);

    const first = cursor.getPendingWindows();
    expect(first).toHaveLength(1);
    expect(first[0].messages).toHaveLength(3);
    expect(first[0].fromSeqExclusive).toBe(0);
    expect(first[0].toSeqInclusive).toBe(3);

    cursor.markWindowProcessed(first[0]);

    const second = cursor.getPendingWindows();
    expect(second).toHaveLength(0);

    messages.push(createMessage(4, 'conv-1', 'Follow-up beschlossen'));

    const third = cursor.getPendingWindows();
    expect(third).toHaveLength(1);
    expect(third[0].messages).toHaveLength(1);
    expect(third[0].messages[0].seq).toBe(4);
    expect(third[0].fromSeqExclusive).toBe(3);

    cursor.markWindowProcessed(third[0]);
    cursor.markWindowProcessed(third[0]);

    const checkpoint = knowledgeRepo.getIngestionCheckpoint('conv-1', 'persona-1');
    expect(checkpoint?.lastSeq).toBe(4);
  });

  it('uses channel-scoped user id for external telegram conversations on legacy user', () => {
    const conversation: Conversation = {
      id: 'conv-telegram-1',
      channelType: 'Telegram' as never,
      externalChatId: '1527785051',
      userId: 'legacy-local-user',
      title: 'Telegram Chat',
      modelOverride: null,
      personaId: 'persona-1',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const messages: StoredMessage[] = [
      createMessage(1, 'conv-telegram-1', 'Gestern Sauna'),
      createMessage(2, 'conv-telegram-1', 'Aufguss und Temperatur'),
    ];

    const messageRepo: MessageRepository = {
      createConversation: () => conversation,
      getConversation: () => conversation,
      getConversationByExternalChat: () => conversation,
      getOrCreateConversation: () => conversation,
      listConversations: () => [conversation],
      updateConversationTitle: () => {},
      saveMessage: () => messages[0],
      getMessage: () => null,
      listMessages: () => messages,
      getDefaultWebChatConversation: () => conversation,
      deleteConversation: () => true,
      updateModelOverride: () => {},
      updatePersonaId: () => {},
      findMessageByClientId: () => null,
      getConversationContext: () => null,
      upsertConversationContext: () => ({
        conversationId: conversation.id,
        summaryText: '',
        summaryUptoSeq: 0,
        updatedAt: new Date().toISOString(),
      }),
      listMessagesAfterSeq: () => messages,
    };

    const knowledgeRepo = {
      getIngestionCheckpoint: () => null,
      upsertIngestionCheckpoint: ({
        conversationId,
        personaId,
        lastSeq,
      }: {
        conversationId: string;
        personaId: string;
        lastSeq: number;
      }) => ({
        conversationId,
        personaId,
        lastSeq,
        updatedAt: new Date().toISOString(),
      }),
      upsertEpisode: () => {
        throw new Error('not used');
      },
      listEpisodes: () => [],
      upsertMeetingLedger: () => {
        throw new Error('not used');
      },
      listMeetingLedger: () => [],
      insertRetrievalAudit: () => {
        throw new Error('not used');
      },
      listRetrievalAudit: () => [],
      getKnowledgeStats: () => ({
        episodeCount: 0,
        ledgerCount: 0,
        retrievalErrorCount: 0,
        latestIngestionAt: null,
        ingestionLagMs: 0,
      }),
      deleteKnowledgeByScope: () => 0,
      pruneKnowledgeBefore: () => ({ episodes: 0, ledger: 0, audits: 0 }),
    } as unknown as KnowledgeRepository;

    const cursor = new KnowledgeIngestionCursor(messageRepo, knowledgeRepo);
    const windows = cursor.getPendingWindows();

    expect(windows).toHaveLength(1);
    expect(windows[0].userId).toBe('legacy-local-user');
  });

  it('does not emit a window until minimum messages per batch is reached', () => {
    const conversation: Conversation = {
      id: 'conv-min-batch',
      channelType: 'WebChat' as never,
      externalChatId: 'default',
      userId: 'user-1',
      title: 'Chat',
      modelOverride: null,
      personaId: 'persona-1',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const messages: StoredMessage[] = Array.from({ length: 49 }, (_, idx) =>
      createMessage(idx + 1, conversation.id, `Nachricht ${idx + 1}`),
    );

    const messageRepo: MessageRepository = {
      createConversation: () => conversation,
      getConversation: () => conversation,
      getConversationByExternalChat: () => conversation,
      getOrCreateConversation: () => conversation,
      listConversations: () => [conversation],
      updateConversationTitle: () => {},
      saveMessage: () => messages[0],
      getMessage: () => null,
      listMessages: () => messages,
      getDefaultWebChatConversation: () => conversation,
      deleteConversation: () => true,
      updateModelOverride: () => {},
      updatePersonaId: () => {},
      findMessageByClientId: () => null,
      getConversationContext: () => null,
      upsertConversationContext: () => ({
        conversationId: conversation.id,
        summaryText: '',
        summaryUptoSeq: 0,
        updatedAt: new Date().toISOString(),
      }),
      listMessagesAfterSeq: () => messages,
    };

    const knowledgeRepo = {
      getIngestionCheckpoint: () => null,
      upsertIngestionCheckpoint: ({
        conversationId,
        personaId,
        lastSeq,
      }: {
        conversationId: string;
        personaId: string;
        lastSeq: number;
      }) => ({
        conversationId,
        personaId,
        lastSeq,
        updatedAt: new Date().toISOString(),
      }),
      upsertEpisode: () => {
        throw new Error('not used');
      },
      listEpisodes: () => [],
      upsertMeetingLedger: () => {
        throw new Error('not used');
      },
      listMeetingLedger: () => [],
      insertRetrievalAudit: () => {
        throw new Error('not used');
      },
      listRetrievalAudit: () => [],
      getKnowledgeStats: () => ({
        episodeCount: 0,
        ledgerCount: 0,
        retrievalErrorCount: 0,
        latestIngestionAt: null,
        ingestionLagMs: 0,
      }),
      deleteKnowledgeByScope: () => 0,
      pruneKnowledgeBefore: () => ({ episodes: 0, ledger: 0, audits: 0 }),
    } as unknown as KnowledgeRepository;

    const cursor = new KnowledgeIngestionCursor(messageRepo, knowledgeRepo, {
      minMessagesPerBatch: 50,
    });

    const first = cursor.getPendingWindows();
    expect(first).toHaveLength(0);

    messages.push(createMessage(50, conversation.id, 'Nachricht 50'));

    const second = cursor.getPendingWindows();
    // With MAX_WINDOW_MESSAGES=30, 50 messages produce 2 sub-windows (30 + 20)
    expect(second).toHaveLength(2);
    expect(second[0].messages).toHaveLength(30);
    expect(second[1].messages).toHaveLength(20);
    // Combined they cover all 50 messages
    expect(second[0].messages.length + second[1].messages.length).toBe(50);
  });
});
