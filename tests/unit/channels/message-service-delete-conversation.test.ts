import { describe, expect, it, vi } from 'vitest';
import type { MessageRepository } from '@/server/channels/messages/repository';
import { MessageService } from '@/server/channels/messages/service';
import { ChannelType } from '@/shared/domain/types';

function buildRepository(
  deleteConversation: MessageRepository['deleteConversation'],
  deleteMessage: NonNullable<MessageRepository['deleteMessage']>,
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
    getMessage: () => ({
      id: 'msg-1',
      conversationId: 'conv-delete',
      role: 'user',
      content: 'hello',
      platform: ChannelType.WEBCHAT,
      externalMsgId: null,
      senderName: null,
      metadata: null,
      createdAt: '2026-02-25T00:00:00.000Z',
    }),
    listMessages: () => {
      throw new Error('unused');
    },
    getDefaultWebChatConversation: () => {
      throw new Error('unused');
    },
    deleteConversation,
    deleteMessage,
    updateModelOverride: () => {
      throw new Error('unused');
    },
    updatePersonaId: () => {
      throw new Error('unused');
    },
    findMessageByClientId: () => null,
    getConversationContext: () => null,
    upsertConversationContext: () => {
      throw new Error('unused');
    },
  };
}

describe('MessageService.deleteConversation', () => {
  it('aborts in-flight generation and clears in-memory state for deleted conversation', () => {
    const deleteConversation = vi.fn(() => true);
    const deleteMessage = vi.fn(() => true);
    const service = new MessageService(buildRepository(deleteConversation, deleteMessage));

    const firstController = new AbortController();
    const secondController = new AbortController();
    const internals = service as unknown as {
      state: {
        activeRequests: Map<string, AbortController>;
      };
      summaryRefreshInFlight: Set<string>;
    };
    internals.state.activeRequests.set('conv-delete', firstController);
    internals.state.activeRequests.set('conv-keep', secondController);
    internals.summaryRefreshInFlight.add('conv-delete');
    internals.summaryRefreshInFlight.add('conv-keep');

    const deleted = service.deleteConversation('conv-delete', 'user-1');

    expect(deleted).toBe(true);
    expect(deleteConversation).toHaveBeenCalledWith('conv-delete', 'user-1');
    expect(firstController.signal.aborted).toBe(true);
    expect(internals.state.activeRequests.has('conv-delete')).toBe(false);
    expect(internals.state.activeRequests.has('conv-keep')).toBe(true);
    expect(internals.summaryRefreshInFlight.has('conv-delete')).toBe(false);
    expect(internals.summaryRefreshInFlight.has('conv-keep')).toBe(true);
  });
});

describe('MessageService.deleteMessage', () => {
  it('clears conversation-local in-memory summary state and deletes the message', () => {
    const deleteConversation = vi.fn(() => true);
    const deleteMessage = vi.fn(() => true);
    const service = new MessageService(buildRepository(deleteConversation, deleteMessage));

    const internals = service as unknown as {
      summaryRefreshInFlight: Set<string>;
    };
    internals.summaryRefreshInFlight.add('conv-delete');
    internals.summaryRefreshInFlight.add('conv-keep');

    const deleted = service.deleteMessage('msg-1', 'user-1');

    expect(deleted).toBe(true);
    expect(deleteMessage).toHaveBeenCalledWith('msg-1', 'user-1');
    expect(internals.summaryRefreshInFlight.has('conv-delete')).toBe(false);
    expect(internals.summaryRefreshInFlight.has('conv-keep')).toBe(true);
  });
});
