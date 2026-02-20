import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelType } from '@/shared/domain/types';
import type { Conversation } from '@/shared/domain/types';
import type { MessageRepository, StoredMessage } from '@/server/channels/messages/repository';

const dispatchWithFallbackMock = vi.hoisted(() =>
  vi.fn(async () => ({
    ok: true,
    text: 'should-not-run',
    provider: 'test-provider',
    model: 'test-model',
  })),
);
const dispatchSkillMock = vi.hoisted(() =>
  vi.fn(async () => ({ stdout: 'ok', stderr: '', exitCode: 0 })),
);
const isCommandApprovedMock = vi.hoisted(() => vi.fn(() => false));
const setInstalledMock = vi.hoisted(() =>
  vi.fn((id: string, installed: boolean) => {
    void id;
    void installed;
    return true;
  }),
);

let shellInstalled = false;

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

vi.mock('../../../src/server/skills/skillRepository', () => ({
  getSkillRepository: async () => ({
    listSkills: () => [
      {
        id: 'shell-access',
        name: 'Safe Shell',
        description: 'Shell skill',
        category: 'Automation',
        version: '1.0.0',
        installed: shellInstalled,
        functionName: 'shell_execute',
        source: 'built-in',
        sourceUrl: null,
      },
    ],
    getSkill: (id: string) =>
      id === 'shell-access'
        ? {
            id: 'shell-access',
            name: 'Safe Shell',
            description: 'Shell skill',
            category: 'Automation',
            version: '1.0.0',
            installed: shellInstalled,
            functionName: 'shell_execute',
            source: 'built-in',
            sourceUrl: null,
            toolDefinition: {
              name: 'shell_execute',
              description: 'Execute shell command',
              parameters: { type: 'object', properties: { command: { type: 'string' } } },
            },
            handlerPath: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }
        : null,
    setInstalled: (id: string, installed: boolean) => {
      setInstalledMock(id, installed);
      if (id === 'shell-access') {
        shellInstalled = installed;
      }
      return true;
    },
  }),
}));

vi.mock('@/skills/definitions', () => ({
  mapSkillsToTools: vi.fn(() => []),
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
    id: 'conv-1',
    channelType: ChannelType.WEBCHAT,
    externalChatId: 'default',
    userId: 'user-1',
    title: 'Chat',
    modelOverride: null,
    personaId: null,
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

describe('MessageService shell-command route', () => {
  beforeEach(() => {
    dispatchWithFallbackMock.mockClear();
    dispatchSkillMock.mockClear();
    setInstalledMock.mockClear();
    isCommandApprovedMock.mockReset();
    isCommandApprovedMock.mockReturnValue(false);
    shellInstalled = false;
    process.env.OPENCLAW_EXEC_APPROVALS_REQUIRED = 'false';
  });

  it('executes /shell directly and auto-installs shell skill', async () => {
    const service = new MessageService(buildRepository());
    const result = await service.handleInbound(
      ChannelType.WEBCHAT,
      'default',
      '/shell echo smoke',
      undefined,
      undefined,
      'user-1',
    );

    expect(setInstalledMock).toHaveBeenCalledWith('shell-access', true);
    expect(dispatchSkillMock).toHaveBeenCalledWith(
      'shell_execute',
      { command: 'echo smoke' },
      expect.objectContaining({ bypassApproval: false }),
    );
    expect(dispatchWithFallbackMock).not.toHaveBeenCalled();
    expect(result.agentMsg.content).toContain('CLI command completed');
  });

  it('returns approval_required metadata for /shell when approvals are required', async () => {
    process.env.OPENCLAW_EXEC_APPROVALS_REQUIRED = 'true';
    const service = new MessageService(buildRepository());
    const result = await service.handleInbound(
      ChannelType.WEBCHAT,
      'default',
      '/shell echo smoke',
      undefined,
      undefined,
      'user-1',
    );

    expect(dispatchSkillMock).not.toHaveBeenCalled();
    const metadata = JSON.parse(String(result.agentMsg.metadata || '{}')) as {
      status?: string;
      approvalToken?: string;
    };
    expect(metadata.status).toBe('approval_required');
    expect(typeof metadata.approvalToken).toBe('string');
  });

  it('infers shell usage for desktop file-count question and answers via model', async () => {
    const service = new MessageService(buildRepository());
    const result = await service.handleInbound(
      ChannelType.WEBCHAT,
      'default',
      'Wie viele dateien habe ich auf dem Desktop?',
      undefined,
      undefined,
      'user-1',
    );

    expect(dispatchSkillMock).toHaveBeenCalledTimes(1);
    const firstCall = dispatchSkillMock.mock.calls[0] as unknown[] | undefined;
    const commandArg = ((firstCall?.[1] as { command?: string } | undefined)?.command || '').trim();
    if (process.platform === 'win32') {
      expect(commandArg).toContain("GetFolderPath('Desktop')");
    } else {
      expect(commandArg).toContain('$HOME/Desktop');
    }
    expect(dispatchWithFallbackMock).toHaveBeenCalledTimes(1);
    expect(result.agentMsg.content).toBe('should-not-run');
  });
});
