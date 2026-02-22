import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Conversation } from '@/shared/domain/types';
import type { StoredMessage } from '@/server/channels/messages/repository';
import { createServerEventBus } from '@/server/events/eventBus';
import { registerProactiveEventSubscribers } from '@/server/proactive/subscribers';

const proactiveIngestMock = vi.hoisted(() => vi.fn(() => 1));
const proactiveEvaluateMock = vi.hoisted(() => vi.fn(() => []));

vi.mock('../../../src/server/proactive/runtime', () => ({
  getProactiveGateService: () => ({
    ingestMessages: proactiveIngestMock,
    evaluate: proactiveEvaluateMock,
  }),
}));

function buildConversation(): Conversation {
  return {
    id: 'c-1',
    channelType: 'WebChat' as never,
    externalChatId: 'default',
    userId: 'user-1',
    title: 'test',
    modelOverride: null,
    personaId: 'persona-1',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function buildUserMessage(): StoredMessage {
  return {
    id: 'm-1',
    conversationId: 'c-1',
    seq: 1,
    role: 'user',
    content: 'Ich investiere in Gold.',
    platform: 'WebChat' as never,
    externalMsgId: null,
    senderName: null,
    metadata: null,
    createdAt: new Date().toISOString(),
  };
}

describe('proactive runtime subscribers', () => {
  beforeEach(() => {
    proactiveIngestMock.mockClear();
    proactiveEvaluateMock.mockClear();
  });

  it('ingests on message persisted and evaluates on summary refreshed', () => {
    const bus = createServerEventBus();
    registerProactiveEventSubscribers(bus);

    const conversation = buildConversation();
    const userMessage = buildUserMessage();

    bus.publish('chat.message.persisted', {
      conversation,
      message: userMessage,
    });

    expect(proactiveIngestMock).toHaveBeenCalledTimes(1);
    expect(proactiveEvaluateMock).toHaveBeenCalledTimes(0);

    bus.publish('chat.summary.refreshed', {
      conversationId: conversation.id,
      userId: conversation.userId,
      personaId: conversation.personaId,
      summaryText: 'summary',
      summaryUptoSeq: 1,
      messages: [userMessage],
      createdAt: new Date().toISOString(),
    });

    expect(proactiveEvaluateMock).toHaveBeenCalledTimes(1);
  });
});
