import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelType } from '@/shared/domain/types';
import type { Conversation } from '@/shared/domain/types';
import type { MessageRepository, StoredMessage } from '@/server/channels/messages/repository';

const dispatchWithFallbackMock = vi.hoisted(() =>
  vi.fn(async (_profileId: string, _key: string, request: { tools?: unknown[] }) => {
    return {
      ok: true,
      text: request.tools ? 'unexpected-tools-enabled' : 'roleplay-no-tools',
      provider: 'test-provider',
      model: 'test-model',
    };
  }),
);
const dispatchSkillMock = vi.hoisted(() =>
  vi.fn(async () => ({ stdout: 'ok', stderr: '', exitCode: 0 })),
);
const isCommandApprovedMock = vi.hoisted(() => vi.fn(() => false));

vi.mock('../../../src/server/model-hub/runtime', () => ({
  getModelHubService: () => ({
    dispatchWithFallback: dispatchWithFallbackMock,
  }),
  getModelHubEncryptionKey: () => 'test-key',
}));

vi.mock('../../../src/server/channels/outbound/router', () => ({
  deliverOutbound: vi.fn(async () => {}),
}));

vi.mock('../../../src/server/gateway/broadcast', () => ({
  broadcastToUser: vi.fn(),
}));

vi.mock('../../../src/server/memory/runtime', () => ({
  getMemoryService: () => ({
    recallDetailed: vi.fn(async () => ({ context: '', matches: [] })),
    store: vi.fn(async () => ({ id: 'mem-1' })),
    updateFeedback: vi.fn(async () => {}),
  }),
}));

vi.mock('../../../src/server/personas/personaRepository', async () => {
  const actual = await vi.importActual('../../../src/server/personas/personaRepository');
  return {
    ...actual,
    getPersonaRepository: () => ({
      getPersona: (id: string) =>
        id === 'persona-rp'
          ? {
              id: 'persona-rp',
              name: 'Roleplay',
              slug: 'roleplay',
              emoji: 'R',
              vibe: 'narrative',
              preferredModelId: null,
              modelHubProfileId: null,
              memoryPersonaType: 'roleplay',
              isAutonomous: false,
              maxToolCalls: 120,
              userId: 'user-1',
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            }
          : null,
      getPersonaSystemInstruction: () => null,
      listPersonas: () => [],
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
  mapSkillsToTools: vi.fn(() => [
    {
      type: 'function',
      function: {
        name: 'shell_execute',
        description: 'Execute shell command',
        parameters: { type: 'object', properties: { command: { type: 'string' } } },
      },
    },
  ]),
}));

vi.mock('../../../src/server/skills/executeSkill', async () => {
  const actual = await vi.importActual('../../../src/server/skills/executeSkill');
  return {
    ...actual,
    dispatchSkill: dispatchSkillMock,
  };
});

vi.mock('../../../src/server/gateway/exec-approval-manager', async () => {
  const actual = await vi.importActual('../../../src/server/gateway/exec-approval-manager');
  return {
    ...actual,
    isCommandApproved: isCommandApprovedMock,
  };
});

import { MessageService } from '@/server/channels/messages/service';

function buildRepository(): MessageRepository {
  let seq = 0;
  const conversation: Conversation = {
    id: 'conv-rp',
    channelType: ChannelType.WEBCHAT,
    externalChatId: 'default',
    userId: 'user-1',
    title: 'Roleplay Chat',
    modelOverride: null,
    personaId: 'persona-rp',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const messages: StoredMessage[] = [];

  const saveMessage = (input: {
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
      conversationId: input.conversationId,
      seq,
      role: input.role,
      content: input.content,
      platform: input.platform,
      externalMsgId: input.externalMsgId ?? null,
      senderName: input.senderName ?? null,
      metadata: input.metadata ? JSON.stringify(input.metadata) : null,
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

describe('MessageService roleplay persona tool policy', () => {
  beforeEach(() => {
    dispatchWithFallbackMock.mockClear();
    dispatchSkillMock.mockClear();
    isCommandApprovedMock.mockReset();
    isCommandApprovedMock.mockReturnValue(false);
    process.env.OPENCLAW_EXEC_APPROVALS_REQUIRED = 'false';
  });

  it('blocks /shell commands for roleplay personas', async () => {
    const service = new MessageService(buildRepository());
    const result = await service.handleInbound(
      ChannelType.WEBCHAT,
      'default',
      '/shell echo blocked',
      undefined,
      undefined,
      'user-1',
    );

    expect(dispatchSkillMock).not.toHaveBeenCalled();
    expect(dispatchWithFallbackMock).not.toHaveBeenCalled();
    expect(result.agentMsg.content).toContain('Roleplay');
    expect(result.agentMsg.content).toContain('deaktiviert');
  });

  it('prevents inferred shell execution and dispatches without tools', async () => {
    const service = new MessageService(buildRepository());
    const result = await service.handleInbound(
      ChannelType.WEBCHAT,
      'default',
      'Wie viele dateien habe ich auf dem Desktop?',
      undefined,
      undefined,
      'user-1',
    );

    expect(dispatchSkillMock).not.toHaveBeenCalled();
    expect(dispatchWithFallbackMock).toHaveBeenCalledTimes(1);
    const call = dispatchWithFallbackMock.mock.calls[0] as
      | [string, string, { tools?: unknown[] }]
      | undefined;
    expect(call?.[2]?.tools).toBeUndefined();
    expect(result.agentMsg.content).toBe('roleplay-no-tools');
  });
});
