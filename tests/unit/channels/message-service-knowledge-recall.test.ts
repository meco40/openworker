import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelType } from '@/shared/domain/types';
import type { Conversation } from '@/shared/domain/types';
import type { MessageRepository, StoredMessage } from '@/server/channels/messages/repository';

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
const knowledgeShouldTriggerRecallMock = vi.hoisted(() => vi.fn(async () => false));
const ensureKnowledgeIngestedForConversationMock = vi.hoisted(() => vi.fn(async () => null));
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
    shouldTriggerRecall: knowledgeShouldTriggerRecallMock,
    retrieve: knowledgeRetrieveMock,
  }),
  ensureKnowledgeIngestedForConversation: ensureKnowledgeIngestedForConversationMock,
}));

import { MessageService } from '@/server/channels/messages/service';

function buildRepository(personaId: string | null, userId = 'user-1'): MessageRepository {
  let seq = 0;
  const messages: StoredMessage[] = [];
  const conversation: Conversation = {
    id: 'conv-1',
    channelType: ChannelType.WEBCHAT,
    externalChatId: 'default',
    userId,
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

function getDispatchedMessages(): Array<{ role: string; content: string }> {
  const call = dispatchWithFallbackMock.mock.calls[0] as unknown[] | undefined;
  const request = (call?.[2] ?? {}) as {
    messages?: Array<{ role: string; content: string }>;
  };
  return request.messages ?? [];
}

describe('MessageService knowledge recall integration', () => {
  beforeEach(() => {
    dispatchWithFallbackMock.mockClear();
    knowledgeRetrieveMock.mockClear();
    knowledgeShouldTriggerRecallMock.mockClear();
    knowledgeShouldTriggerRecallMock.mockResolvedValue(false);
    ensureKnowledgeIngestedForConversationMock.mockClear();
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
    expect(ensureKnowledgeIngestedForConversationMock).toHaveBeenCalledTimes(1);
    expect(ensureKnowledgeIngestedForConversationMock).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      userId: 'user-1',
      personaId: 'persona-1',
    });
    expect(memoryRecallDetailedMock).toHaveBeenCalled();

    const dispatchedMessages = getDispatchedMessages();
    expect(
      dispatchedMessages.some(
        (message) =>
          message.role === 'system' && message.content.includes('Knowledge: Mittags Sauna'),
      ),
    ).toBe(true);
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
    expect(memoryRecallDetailedMock).toHaveBeenCalled();

    const dispatchedMessages = getDispatchedMessages();
    expect(
      dispatchedMessages.some(
        (message) =>
          message.role === 'system' && message.content.includes('Knowledge: Mittags Sauna'),
      ),
    ).toBe(true);
  });

  it('recalls knowledge for known counterpart mentions without requiring explicit probe trigger', async () => {
    const service = new MessageService(buildRepository('persona-1'));
    knowledgeShouldTriggerRecallMock.mockResolvedValueOnce(true);

    await service.handleInbound(
      ChannelType.WEBCHAT,
      'default',
      'Was hat Andreas dazu gesagt?',
      undefined,
      undefined,
      'user-1',
    );

    expect(knowledgeShouldTriggerRecallMock).not.toHaveBeenCalled();
    expect(knowledgeRetrieveMock).toHaveBeenCalledTimes(1);
    expect(memoryRecallDetailedMock).toHaveBeenCalled();
  });

  it('triggers knowledge recall for direct rules question ("Was sind die Regeln?")', async () => {
    const service = new MessageService(buildRepository('persona-1'));

    await service.handleInbound(
      ChannelType.WEBCHAT,
      'default',
      'Was sind die Regeln?',
      undefined,
      undefined,
      'user-1',
    );

    expect(knowledgeRetrieveMock).toHaveBeenCalledTimes(1);
    expect(memoryRecallDetailedMock).toHaveBeenCalled();
  });

  it('triggers knowledge recall for imperative rules request ("Nenne mir die Regeln")', async () => {
    const service = new MessageService(buildRepository('persona-1'));

    await service.handleInbound(
      ChannelType.WEBCHAT,
      'default',
      'Nenne mir die Regeln',
      undefined,
      undefined,
      'user-1',
    );

    expect(knowledgeRetrieveMock).toHaveBeenCalledTimes(1);
    expect(memoryRecallDetailedMock).toHaveBeenCalled();
  });

  it('uses unified legacy scope for telegram in single-user mode (no channel-scoped fallback)', async () => {
    const service = new MessageService(buildRepository('persona-1', 'legacy-local-user'));
    knowledgeRetrieveMock.mockImplementation(async () => {
      return {
        context: 'Knowledge context about sauna details.',
        sections: { answerDraft: '', keyDecisions: '', openPoints: '', evidence: '' },
        references: [],
        tokenCount: 12,
      };
    });

    await service.handleInbound(
      ChannelType.TELEGRAM,
      '1527785051',
      'Erinnerst du dich an gestern Sauna?',
      undefined,
      undefined,
      'legacy-local-user',
    );

    expect(knowledgeRetrieveMock).toHaveBeenCalledTimes(1);
    const calls = knowledgeRetrieveMock.mock.calls as unknown[][];
    const firstCall = (calls[0]?.[0] ?? {}) as Record<string, unknown>;
    expect(firstCall).toMatchObject({
      userId: 'legacy-local-user',
    });
    expect(memoryRecallDetailedMock).toHaveBeenCalled();

    const dispatchedMessages = getDispatchedMessages();
    expect(
      dispatchedMessages.some((message) => message.content.includes('Knowledge context')),
    ).toBe(true);
  });

  it('skips repeated mem0 recall for temporarily empty persona scope', async () => {
    const service = new MessageService(buildRepository('persona-1', 'legacy-local-user'));
    memoryRecallDetailedMock.mockResolvedValue({
      context: 'No relevant memories found.',
      matches: [],
    });

    await service.handleInbound(
      ChannelType.WEBCHAT,
      'default',
      'Erinnerst du dich an unsere Regeln von gestern?',
      undefined,
      undefined,
      'legacy-local-user',
    );

    await service.handleInbound(
      ChannelType.WEBCHAT,
      'default',
      'Erinnerst du dich nochmal an unsere Regeln von gestern?',
      undefined,
      undefined,
      'legacy-local-user',
    );

    expect(memoryRecallDetailedMock).toHaveBeenCalledTimes(1);
  });
});
