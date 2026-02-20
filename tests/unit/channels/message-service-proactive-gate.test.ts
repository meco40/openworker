import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Conversation } from '@/shared/domain/types';
import type { MessageRepository } from '@/server/channels/messages/repository';

const dispatchWithFallbackMock = vi.hoisted(() =>
  vi.fn(async () => ({
    ok: true,
    text: 'AI summary text',
    provider: 'mock-provider',
    model: 'mock-model',
  })),
);

const proactiveIngestMock = vi.hoisted(() => vi.fn(() => 2));
const proactiveEvaluateMock = vi.hoisted(() => vi.fn(() => []));
const memoryStoreMock = vi.hoisted(() => vi.fn(async () => ({ id: 'mem-1' })));

vi.mock('../../../src/server/model-hub/runtime', () => ({
  getModelHubService: () => ({
    dispatchWithFallback: dispatchWithFallbackMock,
  }),
  getModelHubEncryptionKey: () => 'test-encryption-key',
}));

vi.mock('../../../src/server/proactive/runtime', () => ({
  getProactiveGateService: () => ({
    ingestMessages: proactiveIngestMock,
    evaluate: proactiveEvaluateMock,
  }),
}));

vi.mock('../../../src/server/memory/runtime', () => ({
  getMemoryService: () => ({
    store: memoryStoreMock,
  }),
}));

import { MessageService } from '@/server/channels/messages/service';

function buildRepository(): MessageRepository {
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
        content: index === 0 ? 'Ich investiere in Gold.' : `Message ${index + 1}`,
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
    upsertConversationContext: (conversationId, summaryText, summaryUptoSeq, userId) => ({
      userId,
      conversationId,
      summaryText,
      summaryUptoSeq,
      updatedAt: new Date().toISOString(),
    }),
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

describe('MessageService proactive relevance integration', () => {
  beforeEach(() => {
    dispatchWithFallbackMock.mockClear();
    proactiveIngestMock.mockClear();
    proactiveEvaluateMock.mockClear();
    memoryStoreMock.mockClear();
  });

  it('feeds unsummarized messages into proactive gate during summary refresh', async () => {
    const service = new MessageService(buildRepository());
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

    expect(proactiveIngestMock).toHaveBeenCalledTimes(1);
    expect(proactiveEvaluateMock).toHaveBeenCalledTimes(1);
  });
});
