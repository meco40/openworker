import { beforeEach, describe, expect, it, vi } from 'vitest';
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

vi.mock('../../../src/server/model-hub/runtime', () => ({
  getModelHubService: () => ({
    dispatchWithFallback: dispatchWithFallbackMock,
  }),
  getModelHubEncryptionKey: () => 'test-encryption-key',
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

describe('MessageService summary refresh', () => {
  beforeEach(() => {
    dispatchWithFallbackMock.mockClear();
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

    const upsertFn: MessageRepository['upsertConversationContext'] = (
      conversationId,
      summaryText,
      summaryUptoSeq,
      userId,
    ) =>
      upsertContext(conversationId, summaryText, summaryUptoSeq, userId) as ReturnType<
        MessageRepository['upsertConversationContext']
      >;

    const service = new MessageService(buildRepository(upsertFn));
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
});
