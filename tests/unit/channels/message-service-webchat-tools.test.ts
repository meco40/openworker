import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelType } from '@/shared/domain/types';
import type { Conversation } from '@/shared/domain/types';
import type { MessageRepository, StoredMessage } from '@/server/channels/messages/repository';

const dispatchWithFallbackMock = vi.hoisted(() =>
  vi.fn<
    () => Promise<{
      ok: boolean;
      text: string;
      provider: string;
      model: string;
      error?: string;
    }>
  >(async () => ({
    ok: true,
    text: '[model-hub-gateway profile=p9 model=test-model] tool output',
    provider: 'test-provider',
    model: 'test-model',
  })),
);

const deliverOutboundMock = vi.hoisted(() => vi.fn(async () => {}));
const broadcastToUserMock = vi.hoisted(() => vi.fn());
const memoryRecallMock = vi.hoisted(() =>
  vi.fn(async () => ({
    context: '',
    matches: [],
  })),
);

vi.mock('../../../src/server/model-hub/runtime', () => ({
  getModelHubService: () => ({
    dispatchWithFallback: dispatchWithFallbackMock,
  }),
  getModelHubEncryptionKey: () => 'test-key',
}));

vi.mock('../../../src/server/channels/outbound/router', () => ({
  deliverOutbound: deliverOutboundMock,
}));

vi.mock('../../../src/server/gateway/broadcast', () => ({
  broadcastToUser: broadcastToUserMock,
}));

vi.mock('../../../src/server/memory/runtime', () => ({
  getMemoryService: () => ({
    recallDetailed: memoryRecallMock,
    store: vi.fn(async () => ({ id: 'mem-1' })),
    updateFeedback: vi.fn(async () => {}),
  }),
}));

vi.mock('../../../src/server/personas/personaRepository', async () => {
  const actual = await vi.importActual('../../../src/server/personas/personaRepository');
  return {
    ...actual,
    getPersonaRepository: () => ({
      getPersonaSystemInstruction: () => 'You are a specialist persona.',
      getPersona: () => ({
        id: 'persona-1',
        userId: 'user-1',
        preferredModelId: 'gpt-4o-mini',
        modelHubProfileId: 'p9',
      }),
    }),
  };
});

vi.mock('../../../src/server/skills/skillRepository', () => ({
  getSkillRepository: async () => ({
    listSkills: () => [
      {
        id: 'shell-access',
        name: 'Safe Shell',
        description: 'Shell skill',
        category: 'Automation',
        version: '1.0.0',
        installed: true,
        functionName: 'shell_execute',
        source: 'built-in',
        sourceUrl: null,
      },
    ],
    getSkill: () => null,
    setInstalled: () => true,
  }),
}));

vi.mock('@/skills/definitions', () => ({
  mapSkillsToTools: () => [],
}));

import { MessageService } from '@/server/channels/messages/service';

function buildRepository(personaId: string | null): MessageRepository {
  let seq = 0;
  const conversation: Conversation = {
    id: 'conv-1',
    channelType: ChannelType.WEBCHAT,
    externalChatId: 'default',
    userId: 'user-1',
    title: 'Chat',
    modelOverride: null,
    personaId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const messages: StoredMessage[] = [];

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
    const entry: StoredMessage = {
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
    messages.push(entry);
    return entry;
  };

  return {
    createConversation: () => conversation,
    getConversation: () => conversation,
    getConversationByExternalChat: () => conversation,
    getOrCreateConversation: () => conversation,
    listConversations: () => [conversation],
    updateConversationTitle: () => {},
    saveMessage,
    listMessages: () => [...messages],
    getDefaultWebChatConversation: () => conversation,
    getConversationContext: () => null,
    upsertConversationContext: () => ({
      conversationId: conversation.id,
      summaryText: '',
      summaryUptoSeq: 0,
      updatedAt: new Date().toISOString(),
      userId: conversation.userId,
    }),
    deleteConversation: () => true,
    updateModelOverride: () => {},
    updatePersonaId: () => {},
    findMessageByClientId: () => null,
  };
}

describe('MessageService webchat model-hub routing', () => {
  beforeEach(() => {
    dispatchWithFallbackMock.mockClear();
    deliverOutboundMock.mockClear();
    broadcastToUserMock.mockClear();
    memoryRecallMock.mockClear();
  });

  it('dispatches webchat via model hub using persona routing preferences', async () => {
    const service = new MessageService(buildRepository('persona-1'));

    const result = await service.handleInbound(
      ChannelType.WEBCHAT,
      'default',
      'Nutze safe_shell und suche nach notizen.md',
      undefined,
      undefined,
      'user-1',
    );

    expect(dispatchWithFallbackMock).toHaveBeenCalledTimes(1);
    const firstCall = dispatchWithFallbackMock.mock.calls[0] as unknown[];
    expect(firstCall[0]).toBe('p9');
    expect(firstCall[1]).toBe('test-key');

    const request = (firstCall[2] ?? {}) as {
      auditContext?: { kind?: string; conversationId?: string };
      messages?: Array<{ role: string; content: string }>;
    };
    const options = (firstCall[3] ?? {}) as {
      signal?: AbortSignal;
      modelOverride?: string;
    };

    expect(request.auditContext).toEqual({ kind: 'chat', conversationId: 'conv-1' });
    expect(request.messages).toEqual(
      expect.arrayContaining([expect.objectContaining({ role: 'user' })]),
    );
    expect(options.modelOverride).toBe('gpt-4o-mini');
    expect(options.signal).toBeInstanceOf(AbortSignal);

    expect(result.agentMsg.content).toBe('tool output');
  });

  it('returns model-hub errors to the user message flow', async () => {
    dispatchWithFallbackMock.mockResolvedValueOnce({
      ok: false,
      text: '',
      provider: 'test-provider',
      model: 'test-model',
      error: 'pipeline unavailable',
    });

    const service = new MessageService(buildRepository('persona-1'));
    const result = await service.handleInbound(
      ChannelType.WEBCHAT,
      'default',
      'Bitte pruefe den Fehler',
      undefined,
      undefined,
      'user-1',
    );

    expect(dispatchWithFallbackMock).toHaveBeenCalledTimes(1);
    expect(result.agentMsg.content).toContain('pipeline unavailable');
  });
});
