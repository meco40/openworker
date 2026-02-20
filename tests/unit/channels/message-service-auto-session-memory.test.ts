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
        content:
          index === 0
            ? 'Ich trinke Kaffee immer schwarz.'
            : index === 2
              ? 'Morgen um 15:00 habe ich einen Termin.'
              : `Message ${index + 1}`,
        platform: 'WebChat' as never,
        externalMsgId: null,
        senderName: null,
        metadata: null,
        createdAt: '2026-02-14T10:00:00.000Z',
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

describe('MessageService auto session memory', () => {
  beforeEach(() => {
    dispatchWithFallbackMock.mockClear();
    memoryStoreMock.mockClear();
  });

  it('stores auto-generated memory candidates during summary refresh when persona is active', async () => {
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

    expect(dispatchWithFallbackMock).toHaveBeenCalledTimes(1);
    expect(memoryStoreMock).toHaveBeenCalled();
    expect(
      memoryStoreMock.mock.calls.some((call) => {
        const args = call as unknown[];
        return String(args[2] ?? '').includes('Kaffee');
      }),
    ).toBe(true);
  });
});
