import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelType } from '../../../types';
import type { Conversation } from '../../../types';
import type { MessageRepository, StoredMessage } from '../../../src/server/channels/messages/repository';

const dispatchWithFallbackMock = vi.hoisted(() =>
  vi.fn(async () => ({
    ok: true,
    text: 'AI response',
    provider: 'test-provider',
    model: 'test-model',
  })),
);

const deliverOutboundMock = vi.hoisted(() => vi.fn(async () => {}));
const broadcastToUserMock = vi.hoisted(() => vi.fn());
const memoryStoreMock = vi.hoisted(() => vi.fn(async () => ({ id: 'mem-1' })));
const memoryRecallMock = vi.hoisted(() => vi.fn(async () => 'Herr Meco trinkt den Kaffee immer schwarz.'));

vi.mock('../../../src/server/model-hub/runtime', () => ({
  getModelHubService: () => ({
    dispatchWithFallback: dispatchWithFallbackMock,
  }),
  getModelHubEncryptionKey: () => 'test-encryption-key',
}));

vi.mock('../../../src/server/channels/outbound/router', () => ({
  deliverOutbound: deliverOutboundMock,
}));

vi.mock('../../../src/server/gateway/broadcast', () => ({
  broadcastToUser: broadcastToUserMock,
}));

vi.mock('../../../src/server/memory/runtime', () => ({
  getMemoryService: () => ({
    store: memoryStoreMock,
    recall: memoryRecallMock,
  }),
}));

import { MessageService } from '../../../src/server/channels/messages/service';

function buildRepository(personaId: string | null): MessageRepository {
  let seq = 0;
  const messages: StoredMessage[] = [];
  const conversation: Conversation = {
    id: 'conv-1',
    channelType: ChannelType.WEBCHAT,
    externalChatId: 'default',
    userId: 'user-1',
    title: 'Test Chat',
    modelOverride: null,
    personaId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const saveMessage = ({
    conversationId,
    role,
    content,
    platform,
    externalMsgId,
    senderName,
    metadata,
  }: {
    conversationId: string;
    role: 'user' | 'agent' | 'system';
    content: string;
    platform: ChannelType;
    externalMsgId?: string;
    senderName?: string;
    metadata?: Record<string, unknown>;
  }): StoredMessage => {
    const msg: StoredMessage = {
      id: `msg-${++seq}`,
      conversationId,
      seq,
      role,
      content,
      platform,
      externalMsgId: externalMsgId ?? null,
      senderName: senderName ?? null,
      metadata: metadata ? JSON.stringify(metadata) : null,
      createdAt: new Date().toISOString(),
    };
    messages.push(msg);
    return msg;
  };

  return {
    createConversation: () => conversation,
    getConversation: () => conversation,
    getConversationByExternalChat: () => conversation,
    getOrCreateConversation: () => conversation,
    listConversations: () => [conversation],
    updateConversationTitle: () => {},
    saveMessage,
    listMessages: () => messages,
    getDefaultWebChatConversation: () => conversation,
    deleteConversation: () => true,
    updateModelOverride: () => {},
    updatePersonaId: () => {},
    findMessageByClientId: () => null,
    getConversationContext: () => null,
    upsertConversationContext: (conversationId, summaryText, summaryUptoSeq) => ({
      conversationId,
      summaryText,
      summaryUptoSeq,
      updatedAt: new Date().toISOString(),
    }),
  };
}

describe('MessageService memory recall gating', () => {
  beforeEach(() => {
    dispatchWithFallbackMock.mockClear();
    deliverOutboundMock.mockClear();
    broadcastToUserMock.mockClear();
    memoryStoreMock.mockClear();
    memoryRecallMock.mockClear();
    memoryRecallMock.mockResolvedValue('Herr Meco trinkt den Kaffee immer schwarz.');
  });

  it('injects recalled memory context for memory-like user questions', async () => {
    const service = new MessageService(buildRepository('persona-1'));

    await service.handleInbound(
      ChannelType.WEBCHAT,
      'default',
      'Wie trinke ich meinen Kaffee?',
      undefined,
      undefined,
      'user-1',
    );

    expect(memoryRecallMock).toHaveBeenCalledTimes(1);
    expect(memoryRecallMock).toHaveBeenCalledWith(
      'persona-1',
      'Wie trinke ich meinen Kaffee?',
      3,
    );

    const firstDispatchCall = dispatchWithFallbackMock.mock.calls[0] as unknown[] | undefined;
    const dispatchInput = (firstDispatchCall?.[2] ?? {}) as { messages?: Array<{
      role: string;
      content: string;
    }> };
    const dispatchedMessages = dispatchInput.messages ?? [];
    expect(dispatchedMessages[0]?.role).toBe('system');
    expect(dispatchedMessages[0]?.content).toContain('Relevant memory context');
    expect(dispatchedMessages[0]?.content).toContain('Kaffee immer schwarz');
  });

  it('skips recall for non-memory-like prompts to avoid extra cost', async () => {
    const service = new MessageService(buildRepository('persona-1'));

    await service.handleInbound(
      ChannelType.WEBCHAT,
      'default',
      'Schreibe mir bitte eine freundliche Begrüßung.',
      undefined,
      undefined,
      'user-1',
    );

    expect(memoryRecallMock).not.toHaveBeenCalled();
  });
});
