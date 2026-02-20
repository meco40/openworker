import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelType } from '../../../types';
import type { Conversation } from '../../../types';
import type {
  MessageRepository,
  StoredMessage,
} from '../../../src/server/channels/messages/repository';

const dispatchWithFallbackMock = vi.hoisted(() =>
  vi.fn<
    () => Promise<{
      ok: boolean;
      text: string;
      provider: string;
      model: string;
      functionCalls?: Array<{ name: string; args?: unknown }>;
      error?: string;
    }>
  >(),
);
const dispatchSkillMock = vi.hoisted(() =>
  vi.fn(async () => ({ stdout: 'ok', stderr: '', exitCode: 0 })),
);
const approveCommandMock = vi.hoisted(() => vi.fn());
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

vi.mock('../../../skills/definitions', () => ({
  mapSkillsToTools: () => [
    {
      type: 'function',
      function: {
        name: 'shell_execute',
        description: 'Execute shell command',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string' },
          },
          required: ['command'],
        },
      },
    },
  ],
}));

vi.mock('../../../src/server/skills/skillRepository', () => ({
  getSkillRepository: async () => ({
    listSkills: () => [
      {
        id: 'skill-shell',
        name: 'Shell Execute',
        description: 'Run shell command',
        category: 'tool',
        installed: true,
        version: '1.0.0',
        functionName: 'shell_execute',
        source: 'builtin',
        sourceUrl: null,
      },
    ],
  }),
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
    approveCommand: approveCommandMock,
    isCommandApproved: isCommandApprovedMock,
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

describe('MessageService tool approval flow', () => {
  const previousApprovalsRequired = process.env.OPENCLAW_EXEC_APPROVALS_REQUIRED;

  beforeEach(() => {
    process.env.OPENCLAW_EXEC_APPROVALS_REQUIRED = 'true';
    dispatchWithFallbackMock.mockReset();
    dispatchSkillMock.mockClear();
    approveCommandMock.mockClear();
    isCommandApprovedMock.mockReset();
    isCommandApprovedMock.mockReturnValue(false);
  });

  afterEach(() => {
    if (previousApprovalsRequired === undefined) {
      delete process.env.OPENCLAW_EXEC_APPROVALS_REQUIRED;
    } else {
      process.env.OPENCLAW_EXEC_APPROVALS_REQUIRED = previousApprovalsRequired;
    }
  });

  it('executes approve-once tool runs with bypassApproval after chat approval', async () => {
    dispatchWithFallbackMock
      .mockResolvedValueOnce({
        ok: true,
        text: '',
        provider: 'test-provider',
        model: 'test-model',
        functionCalls: [{ name: 'shell_execute', args: { command: 'echo hello' } }],
      })
      .mockResolvedValueOnce({
        ok: true,
        text: '[model-hub-gateway profile=p9 model=test-model] erledigt',
        provider: 'test-provider',
        model: 'test-model',
      });

    const service = new MessageService(buildRepository('persona-1'));
    const firstRun = await service.handleInbound(
      ChannelType.WEBCHAT,
      'default',
      'Bitte fuehre echo hello aus',
      undefined,
      undefined,
      'user-1',
    );

    const metadata = JSON.parse(String(firstRun.agentMsg.metadata || '{}')) as {
      status?: string;
      approvalToken?: string;
    };

    expect(metadata.status).toBe('approval_required');
    expect(typeof metadata.approvalToken).toBe('string');

    const approvalResult = await service.respondToolApproval({
      conversationId: 'conv-1',
      userId: 'user-1',
      approvalToken: String(metadata.approvalToken),
      approved: true,
      approveAlways: false,
      toolFunctionName: 'shell_execute',
    });

    expect(approvalResult).toEqual({
      ok: true,
      status: 'approved',
      policyUpdated: false,
    });
    expect(dispatchSkillMock).toHaveBeenCalledWith(
      'shell_execute',
      { command: 'echo hello' },
      expect.objectContaining({ bypassApproval: true }),
    );
    expect(approveCommandMock).not.toHaveBeenCalled();
    expect(dispatchWithFallbackMock).toHaveBeenCalledTimes(2);
  });
});
