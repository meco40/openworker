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
    text: 'fallback text',
    provider: 'test-provider',
    model: 'test-model',
  })),
);

const resolveEnabledToolsMock = vi.hoisted(() => vi.fn(() => ['safe_shell']));
const resolveToolPolicyMock = vi.hoisted(() =>
  vi.fn(() => ({
    defaultMode: 'ask_approve',
    byFunctionName: { safe_shell: 'approve_always' },
  })),
);
const startRunMock = vi.hoisted(() =>
  vi.fn(async () => ({
    runId: 'chat-run-1',
    status: 'completed',
    output: '[model-hub-gateway profile=p9 model=openai:gpt-4o-mini] tool output',
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

vi.mock('../../../src/server/config/gatewayConfig', () => ({
  loadGatewayConfig: vi.fn(async () => ({ config: {}, revision: 'rev-1' })),
}));

vi.mock('../../../src/server/worker/openai/openaiToolRegistry', () => ({
  resolveEnabledOpenAiWorkerToolNamesFromConfig: resolveEnabledToolsMock,
  resolveOpenAiWorkerToolApprovalPolicyFromConfig: resolveToolPolicyMock,
}));

vi.mock('../../../src/server/worker/openai/openaiWorkerClient', () => ({
  getOpenAiWorkerClient: () => ({
    startRun: startRunMock,
  }),
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

import { MessageService } from '../../../src/server/channels/messages/service';

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

describe('MessageService webchat tools routing', () => {
  beforeEach(() => {
    dispatchWithFallbackMock.mockClear();
    resolveEnabledToolsMock.mockClear();
    resolveToolPolicyMock.mockClear();
    startRunMock.mockClear();
    deliverOutboundMock.mockClear();
    broadcastToUserMock.mockClear();
    memoryRecallMock.mockClear();
  });

  it('uses OpenAI sidecar run when worker tools are enabled for webchat', async () => {
    const service = new MessageService(buildRepository('persona-1'));

    const result = await service.handleInbound(
      ChannelType.WEBCHAT,
      'default',
      'Nutze safe_shell und suche nach notizen.md',
      undefined,
      undefined,
      'user-1',
    );

    expect(startRunMock).toHaveBeenCalledTimes(1);
    expect(startRunMock).toHaveBeenCalledWith(
      expect.objectContaining({
        objective: 'Nutze safe_shell und suche nach notizen.md',
        personaId: 'persona-1',
        preferredModelId: 'gpt-4o-mini',
        modelHubProfileId: 'p9',
        enabledTools: ['safe_shell'],
        toolApprovalPolicy: {
          defaultMode: 'ask_approve',
          byFunctionName: { safe_shell: 'approve_always' },
        },
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: 'system',
            content: expect.stringContaining('safe_shell'),
          }),
          expect.objectContaining({ role: 'user' }),
        ]),
      }),
    );
    expect(dispatchWithFallbackMock).not.toHaveBeenCalled();
    expect(result.agentMsg.content).toBe('tool output');
  });

  it('falls back and applies sidecar cooldown when sidecar is unreachable', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchFailure = new TypeError('fetch failed') as TypeError & {
      cause?: { code?: string };
    };
    fetchFailure.cause = { code: 'ECONNREFUSED' };
    startRunMock.mockRejectedValueOnce(fetchFailure);

    const service = new MessageService(buildRepository('persona-1'));

    await service.handleInbound(
      ChannelType.WEBCHAT,
      'default',
      'Bitte lese die README',
      undefined,
      undefined,
      'user-1',
    );
    await service.handleInbound(
      ChannelType.WEBCHAT,
      'default',
      'Und jetzt führe safe_shell aus',
      undefined,
      undefined,
      'user-1',
    );

    expect(startRunMock).toHaveBeenCalledTimes(1);
    expect(dispatchWithFallbackMock).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('OpenAI sidecar unavailable'));
    expect(errorSpy).not.toHaveBeenCalledWith(
      'OpenAI sidecar chat dispatch failed, falling back to model hub:',
      expect.anything(),
    );

    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
