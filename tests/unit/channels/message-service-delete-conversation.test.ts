import { describe, expect, it, vi } from 'vitest';
import type { MessageRepository } from '../../../src/server/channels/messages/repository';
import { MessageService } from '../../../src/server/channels/messages/service';

function buildRepository(deleteConversation: MessageRepository['deleteConversation']): MessageRepository {
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
    listMessages: () => {
      throw new Error('unused');
    },
    getDefaultWebChatConversation: () => {
      throw new Error('unused');
    },
    deleteConversation,
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
    const service = new MessageService(buildRepository(deleteConversation));

    const firstController = new AbortController();
    const secondController = new AbortController();
    const internals = service as unknown as {
      activeRequests: Map<string, AbortController>;
      summaryRefreshInFlight: Set<string>;
    };
    internals.activeRequests.set('conv-delete', firstController);
    internals.activeRequests.set('conv-keep', secondController);
    internals.summaryRefreshInFlight.add('conv-delete');
    internals.summaryRefreshInFlight.add('conv-keep');

    const deleted = service.deleteConversation('conv-delete', 'user-1');

    expect(deleted).toBe(true);
    expect(deleteConversation).toHaveBeenCalledWith('conv-delete', 'user-1');
    expect(firstController.signal.aborted).toBe(true);
    expect(internals.activeRequests.has('conv-delete')).toBe(false);
    expect(internals.activeRequests.has('conv-keep')).toBe(true);
    expect(internals.summaryRefreshInFlight.has('conv-delete')).toBe(false);
    expect(internals.summaryRefreshInFlight.has('conv-keep')).toBe(true);
  });
});
