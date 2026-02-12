import { describe, expect, it } from 'vitest';
import { ContextBuilder } from '../../../src/server/channels/messages/contextBuilder';
import type { MessageRepository } from '../../../src/server/channels/messages/repository';
import { ChannelType } from '../../../types';

function createRepo(): MessageRepository {
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
    listMessages: () => [
      {
        id: 'm1',
        conversationId: 'c1',
        seq: 1,
        role: 'user',
        content: 'First',
        platform: ChannelType.WEBCHAT,
        externalMsgId: null,
        senderName: null,
        metadata: null,
        createdAt: new Date().toISOString(),
      },
      {
        id: 'm2',
        conversationId: 'c1',
        seq: 2,
        role: 'agent',
        content: 'Second',
        platform: ChannelType.WEBCHAT,
        externalMsgId: null,
        senderName: null,
        metadata: null,
        createdAt: new Date().toISOString(),
      },
    ],
    getDefaultWebChatConversation: () => {
      throw new Error('unused');
    },
    getConversationContext: () => ({
      conversationId: 'c1',
      summaryText: 'User prefers concise answers.',
      summaryUptoSeq: 1,
      updatedAt: new Date().toISOString(),
    }),
    upsertConversationContext: () => {
      throw new Error('unused');
    },
    deleteConversation: () => {
      throw new Error('unused');
    },
    updateModelOverride: () => {
      throw new Error('unused');
    },
    updatePersonaId: () => {
      throw new Error('unused');
    },
    findMessageByClientId: () => {
      throw new Error('unused');
    },
  };
}

describe('ContextBuilder', () => {
  it('prepends summary as system context and maps roles for gateway dispatch', () => {
    const builder = new ContextBuilder(createRepo());
    const messages = builder.buildGatewayMessages('c1', 'u1', 20);

    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({
      role: 'system',
      content: 'Conversation summary: User prefers concise answers.',
    });
    expect(messages[1]).toEqual({
      role: 'assistant',
      content: 'Second',
    });
  });
});
