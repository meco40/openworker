import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelType } from '@/shared/domain/types';
import type { MessageRepository, StoredMessage } from '@/server/channels/messages/repository';
import type { Conversation } from '@/shared/domain/types';
import { LEGACY_LOCAL_USER_ID } from '@/server/auth/constants';

const dispatchWithFallbackMock = vi.hoisted(() =>
  vi.fn(async () => ({
    ok: true,
    text: 'AI fallback response',
    provider: 'test-provider',
    model: 'test-model',
  })),
);

const deliverOutboundMock = vi.hoisted(() => vi.fn(async () => {}));
const broadcastToUserMock = vi.hoisted(() => vi.fn());
const memoryStoreMock = vi.hoisted(() =>
  vi.fn(async () => ({
    id: 'mem-1',
  })),
);

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
  }),
}));

import { MessageService } from '@/server/channels/messages/service';

function buildRepository(
  personaId: string | null,
  overrides?: Partial<Pick<Conversation, 'channelType' | 'externalChatId' | 'userId'>>,
): MessageRepository {
  let seq = 0;
  const conversation: Conversation = {
    id: 'conv-1',
    channelType: overrides?.channelType ?? ChannelType.WEBCHAT,
    externalChatId: overrides?.externalChatId ?? 'default',
    userId: overrides?.userId ?? 'user-1',
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
  }): StoredMessage => ({
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
  });

  return {
    createConversation: () => conversation,
    getConversation: () => conversation,
    getConversationByExternalChat: () => conversation,
    getOrCreateConversation: () => conversation,
    listConversations: () => [conversation],
    updateConversationTitle: () => {},
    saveMessage,
    listMessages: () => [],
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

describe('MessageService memory trigger', () => {
  beforeEach(() => {
    dispatchWithFallbackMock.mockClear();
    deliverOutboundMock.mockClear();
    broadcastToUserMock.mockClear();
    memoryStoreMock.mockClear();
  });

  it('stores memory when message starts with "Speichere ab:" and persona is active', async () => {
    const service = new MessageService(buildRepository('persona-1'));

    const result = await service.handleInbound(
      ChannelType.WEBCHAT,
      'default',
      'Speichere ab: Ich mag Lasagne',
      undefined,
      undefined,
      'user-1',
    );

    expect(memoryStoreMock).toHaveBeenCalledTimes(1);
    expect(memoryStoreMock).toHaveBeenCalledWith(
      'persona-1',
      'fact',
      'Ich mag Lasagne',
      4,
      'user-1',
      expect.objectContaining({
        subject: 'user',
        sourceRole: 'user',
        sourceType: 'manual_save',
      }),
    );
    expect(dispatchWithFallbackMock).not.toHaveBeenCalled();
    expect(result.agentMsg.content.toLowerCase()).toContain('gespeichert');
  });

  it('stores memory when message starts with "Speichere ab" without colon and persona is active', async () => {
    const service = new MessageService(buildRepository('persona-1'));

    const result = await service.handleInbound(
      ChannelType.WEBCHAT,
      'default',
      'Speichere ab Ich mag Pasta',
      undefined,
      undefined,
      'user-1',
    );

    expect(memoryStoreMock).toHaveBeenCalledTimes(1);
    expect(memoryStoreMock).toHaveBeenCalledWith(
      'persona-1',
      'fact',
      'Ich mag Pasta',
      4,
      'user-1',
      expect.objectContaining({
        subject: 'user',
        sourceRole: 'user',
        sourceType: 'manual_save',
      }),
    );
    expect(dispatchWithFallbackMock).not.toHaveBeenCalled();
    expect(result.agentMsg.content.toLowerCase()).toContain('gespeichert');
  });

  it('does not store memory when no persona is active', async () => {
    const service = new MessageService(buildRepository(null));

    const result = await service.handleInbound(
      ChannelType.WEBCHAT,
      'default',
      'Speichere ab: Merke dir meinen Lieblingsfilm ist Inception',
      undefined,
      undefined,
      'user-1',
    );

    expect(memoryStoreMock).not.toHaveBeenCalled();
    expect(dispatchWithFallbackMock).not.toHaveBeenCalled();
    expect(result.agentMsg.content.toLowerCase()).toContain('persona');
  });

  it('uses unified memory user id for telegram in single-user mode', async () => {
    const service = new MessageService(
      buildRepository('persona-1', {
        channelType: ChannelType.TELEGRAM,
        externalChatId: '1527785051',
        userId: LEGACY_LOCAL_USER_ID,
      }),
    );

    await service.handleInbound(
      ChannelType.TELEGRAM,
      '1527785051',
      'Speichere ab: Ich mag Tee',
      'telegram-user',
      'ext-1',
    );

    expect(memoryStoreMock).toHaveBeenCalledTimes(1);
    expect(memoryStoreMock).toHaveBeenCalledWith(
      'persona-1',
      'fact',
      'Ich mag Tee',
      4,
      LEGACY_LOCAL_USER_ID,
      expect.objectContaining({
        subject: 'user',
        sourceRole: 'user',
        sourceType: 'manual_save',
      }),
    );
  });
});
