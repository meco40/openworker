import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { Conversation } from '@/shared/domain/types';
import type { MessageRepository } from '@/server/channels/messages/repository';

const dispatchWithFallbackMock = vi.hoisted(() =>
  vi.fn(async () => ({
    ok: true,
    text: 'AI summary text',
    provider: 'openai',
    model: 'gpt-4o-mini',
  })),
);
const knowledgeIngestConversationWindowMock = vi.hoisted(() => vi.fn(async () => null));
const memoryStoreMock = vi.hoisted(() => vi.fn(async () => ({ id: 'mem-1' })));

vi.mock('../../../src/server/model-hub/runtime', () => ({
  getModelHubService: () => ({
    dispatchWithFallback: dispatchWithFallbackMock,
  }),
  getModelHubEncryptionKey: () => 'test-encryption-key',
}));

vi.mock('../../../src/server/memory/runtime', () => ({
  getMemoryService: () => ({
    store: memoryStoreMock,
  }),
}));

vi.mock('../../../src/server/knowledge/config', () => ({
  resolveKnowledgeConfig: () => ({
    layerEnabled: true,
    ledgerEnabled: true,
    episodeEnabled: true,
  }),
}));

vi.mock('../../../src/server/knowledge/runtime', () => ({
  getKnowledgeIngestionService: () => ({
    ingestConversationWindow: knowledgeIngestConversationWindowMock,
  }),
}));

import { MessageService } from '@/server/channels/messages/service';

function buildRepository(
  upsert: MessageRepository['upsertConversationContext'],
): MessageRepository {
  return {
    createConversation: () => {
      throw new Error('unused');
    },
    getConversation: () => {
      throw new Error('unused');
    },
    getConversationByExternalChat: () => {
      throw new Error('unused');
    },
    getOrCreateConversation: () => {
      throw new Error('unused');
    },
    listConversations: () => {
      throw new Error('unused');
    },
    updateConversationTitle: () => {
      throw new Error('unused');
    },
    saveMessage: () => {
      throw new Error('unused');
    },
    listMessages: () =>
      Array.from({ length: 25 }, (_, index) => ({
        id: `m-${index + 1}`,
        conversationId: 'c-1',
        seq: index + 1,
        role: index % 2 === 0 ? 'user' : 'agent',
        content: `Message ${index + 1}`,
        platform: 'WebChat' as never,
        externalMsgId: null,
        senderName: null,
        metadata: null,
        createdAt: new Date().toISOString(),
      })),
    getDefaultWebChatConversation: () => {
      throw new Error('unused');
    },
    getConversationContext: () => ({
      conversationId: 'c-1',
      summaryText: '',
      summaryUptoSeq: 0,
      updatedAt: new Date().toISOString(),
    }),
    upsertConversationContext: upsert,
    deleteConversation: () => {
      throw new Error('unused');
    },
    updateModelOverride: () => {
      throw new Error('unused');
    },
    updatePersonaId: () => {
      throw new Error('unused');
    },
    findMessageByClientId: () => null,
  };
}

function createUpsertFn(upsertContext: Mock): MessageRepository['upsertConversationContext'] {
  return (conversationId, summaryText, summaryUptoSeq, userId) =>
    upsertContext(conversationId, summaryText, summaryUptoSeq, userId) as ReturnType<
      MessageRepository['upsertConversationContext']
    >;
}

describe('MessageService summary refresh', () => {
  beforeEach(() => {
    dispatchWithFallbackMock.mockClear();
    knowledgeIngestConversationWindowMock.mockClear();
    memoryStoreMock.mockClear();
    delete process.env.KNOWLEDGE_INLINE_INGESTION_ENABLED;
  });

  it('uses model hub summarization when refreshing conversation summary', async () => {
    const upsertContext = vi.fn(
      (conversationId: string, summaryText: string, summaryUptoSeq: number, userId?: string) => ({
        userId,
        conversationId,
        summaryText,
        summaryUptoSeq,
        updatedAt: new Date().toISOString(),
      }),
    );

    const service = new MessageService(buildRepository(createUpsertFn(upsertContext)));
    const conversation: Conversation = {
      id: 'c-1',
      channelType: 'WebChat' as never,
      externalChatId: 'default',
      userId: 'user-1',
      title: 'Summary Test',
      modelOverride: null,
      personaId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await (
      service as unknown as { maybeRefreshConversationSummary: (c: Conversation) => Promise<void> }
    ).maybeRefreshConversationSummary(conversation);

    expect(dispatchWithFallbackMock).toHaveBeenCalledTimes(1);
    expect(upsertContext).toHaveBeenCalledTimes(1);
    expect(upsertContext.mock.calls[0]?.[1]).toBe('AI summary text');
  });

  it('does not run inline knowledge ingestion during summary refresh by default', async () => {
    const upsertContext = vi.fn(
      (conversationId: string, summaryText: string, summaryUptoSeq: number, userId?: string) => ({
        userId,
        conversationId,
        summaryText,
        summaryUptoSeq,
        updatedAt: new Date().toISOString(),
      }),
    );

    const service = new MessageService(buildRepository(createUpsertFn(upsertContext)));
    const conversation: Conversation = {
      id: 'c-1',
      channelType: 'WebChat' as never,
      externalChatId: 'default',
      userId: 'user-1',
      title: 'Summary Test',
      modelOverride: null,
      personaId: 'persona-1',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await (
      service as unknown as { maybeRefreshConversationSummary: (c: Conversation) => Promise<void> }
    ).maybeRefreshConversationSummary(conversation);
    await Promise.resolve();

    expect(knowledgeIngestConversationWindowMock).not.toHaveBeenCalled();
  });

  it('allows inline knowledge ingestion during summary refresh only when explicitly enabled', async () => {
    process.env.KNOWLEDGE_INLINE_INGESTION_ENABLED = 'true';
    const upsertContext = vi.fn(
      (conversationId: string, summaryText: string, summaryUptoSeq: number, userId?: string) => ({
        userId,
        conversationId,
        summaryText,
        summaryUptoSeq,
        updatedAt: new Date().toISOString(),
      }),
    );

    const service = new MessageService(buildRepository(createUpsertFn(upsertContext)));
    const conversation: Conversation = {
      id: 'c-1',
      channelType: 'WebChat' as never,
      externalChatId: 'default',
      userId: 'user-1',
      title: 'Summary Test',
      modelOverride: null,
      personaId: 'persona-1',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await (
      service as unknown as { maybeRefreshConversationSummary: (c: Conversation) => Promise<void> }
    ).maybeRefreshConversationSummary(conversation);

    await vi.waitFor(() => {
      expect(knowledgeIngestConversationWindowMock).toHaveBeenCalledTimes(1);
    });
    expect(knowledgeIngestConversationWindowMock).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'c-1',
        userId: 'user-1',
        personaId: 'persona-1',
      }),
    );
  });
});
