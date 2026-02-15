import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelType } from '../../../types';
import type { Conversation } from '../../../types';
import type {
  MessageRepository,
  StoredMessage,
} from '../../../src/server/channels/messages/repository';

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
const knowledgeRetrieveMock = vi.hoisted(() =>
  vi.fn(async () => ({
    context: 'Knowledge: Mittags Sauna mit Details zu Temperatur und Aufguss.',
    sections: {
      answerDraft: '',
      keyDecisions: '',
      openPoints: '',
      evidence: '',
    },
    references: [],
    tokenCount: 42,
  })),
);
const memoryRecallDetailedMock = vi.hoisted(() =>
  vi.fn(async () => ({
    context: 'Mem0 fallback context',
    matches: [],
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
    store: vi.fn(async () => ({ id: 'mem-1' })),
    recallDetailed: memoryRecallDetailedMock,
    registerFeedback: vi.fn(async () => 0),
  }),
}));

vi.mock('../../../src/server/knowledge/config', () => ({
  resolveKnowledgeConfig: () => ({
    layerEnabled: true,
    ledgerEnabled: true,
    episodeEnabled: true,
    retrievalEnabled: true,
    maxContextTokens: 1200,
    ingestIntervalMs: 600000,
  }),
}));

vi.mock('../../../src/server/knowledge/runtime', () => ({
  getKnowledgeRetrievalService: () => ({
    retrieve: knowledgeRetrieveMock,
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

  return {
    createConversation: () => conversation,
    getConversation: () => conversation,
    getConversationByExternalChat: () => conversation,
    getOrCreateConversation: () => conversation,
    listConversations: () => [conversation],
    updateConversationTitle: () => {},
    saveMessage: ({
      conversationId,
      role,
      content,
      platform,
      externalMsgId,
      senderName,
      metadata,
    }) => {
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
    },
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

describe('MessageService knowledge recall integration', () => {
  beforeEach(() => {
    dispatchWithFallbackMock.mockClear();
    knowledgeRetrieveMock.mockClear();
    memoryRecallDetailedMock.mockClear();
  });

  it('injects knowledge context for retrospective sauna prompt before mem0 fallback', async () => {
    const service = new MessageService(buildRepository('persona-1'));

    await service.handleInbound(
      ChannelType.WEBCHAT,
      'default',
      'Was haben wir letztes ueber sauna gesprochen?',
      undefined,
      undefined,
      'user-1',
    );

    expect(knowledgeRetrieveMock).toHaveBeenCalledTimes(1);
    expect(memoryRecallDetailedMock).not.toHaveBeenCalled();

    const call = dispatchWithFallbackMock.mock.calls[0] as unknown[] | undefined;
    const dispatchInput = (call?.[2] ?? {}) as { messages?: Array<{ role: string; content: string }> };
    const dispatchedMessages = dispatchInput.messages ?? [];
    expect(dispatchedMessages[0]?.role).toBe('system');
    expect(dispatchedMessages[0]?.content).toContain('Knowledge: Mittags Sauna');
  });

  it('injects knowledge context for compact retrospective wording ("wie war gestern sauna?")', async () => {
    const service = new MessageService(buildRepository('persona-1'));

    await service.handleInbound(
      ChannelType.WEBCHAT,
      'default',
      'wie war gestern sauna?',
      undefined,
      undefined,
      'user-1',
    );

    expect(knowledgeRetrieveMock).toHaveBeenCalledTimes(1);
    expect(memoryRecallDetailedMock).not.toHaveBeenCalled();

    const call = dispatchWithFallbackMock.mock.calls[0] as unknown[] | undefined;
    const dispatchInput = (call?.[2] ?? {}) as { messages?: Array<{ role: string; content: string }> };
    const dispatchedMessages = dispatchInput.messages ?? [];
    expect(dispatchedMessages[0]?.role).toBe('system');
    expect(dispatchedMessages[0]?.content).toContain('Knowledge: Mittags Sauna');
  });
});
