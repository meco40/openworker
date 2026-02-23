import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelType } from '@/shared/domain/types';
import { MessageService } from '@/server/channels/messages/service';
import { SqliteMessageRepository } from '@/server/channels/messages/sqliteMessageRepository';

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
      listPersonas: () => [
        {
          id: 'persona-1',
          name: 'Builder',
          slug: 'builder',
          emoji: 'B',
          vibe: 'build',
          preferredModelId: null,
          modelHubProfileId: null,
          memoryPersonaType: 'builder',
          updatedAt: new Date().toISOString(),
        },
      ],
      getPersona: (id: string) =>
        id === 'persona-1'
          ? {
              id: 'persona-1',
              name: 'Builder',
              slug: 'builder',
              emoji: 'B',
              vibe: 'build',
              preferredModelId: null,
              modelHubProfileId: null,
              memoryPersonaType: 'builder',
              userId: 'user-1',
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            }
          : null,
      getPersonaSystemInstruction: () => null,
    }),
  };
});

vi.mock('../../../src/server/skills/skillRepository', () => ({
  getSkillRepository: async () => ({
    listSkills: () => [
      {
        id: 'shell-access',
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
    getSkill: () => null,
    setInstalled: () => true,
  }),
}));

vi.mock('@/skills/definitions', () => ({
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

describe('MessageService active project workspaceCwd wiring', () => {
  const previousApprovalsRequired = process.env.OPENCLAW_EXEC_APPROVALS_REQUIRED;
  let repo: SqliteMessageRepository;
  let service: MessageService;

  beforeEach(async () => {
    process.env.OPENCLAW_EXEC_APPROVALS_REQUIRED = 'false';
    repo = new SqliteMessageRepository(':memory:');
    service = new MessageService(repo);
    dispatchWithFallbackMock.mockReset();
    dispatchSkillMock.mockClear();
    isCommandApprovedMock.mockReset();
    isCommandApprovedMock.mockReturnValue(false);
    const conversation = repo.getOrCreateConversation(
      ChannelType.WEBCHAT,
      'default',
      undefined,
      'user-1',
    );
    repo.updatePersonaId(conversation.id, 'persona-1', 'user-1');
    const project = repo.createProject?.({
      userId: 'user-1',
      personaId: 'persona-1',
      name: 'Notes',
      workspacePath: 'D:/tmp/workspace-notes',
    });
    repo.setActiveProjectForConversation?.(conversation.id, 'user-1', project?.id || null);
  });

  afterEach(() => {
    if (previousApprovalsRequired === undefined) {
      delete process.env.OPENCLAW_EXEC_APPROVALS_REQUIRED;
    } else {
      process.env.OPENCLAW_EXEC_APPROVALS_REQUIRED = previousApprovalsRequired;
    }
  });

  function getActiveWorkspacePath(): string {
    const conversation = repo.getConversationByExternalChat(
      ChannelType.WEBCHAT,
      'default',
      'user-1',
    );
    expect(conversation).not.toBeNull();
    const state = repo.getConversationProjectState?.(String(conversation?.id), 'user-1');
    expect(state?.activeProjectId).toBeTruthy();
    const project = repo.getProjectByIdOrSlug?.(
      'persona-1',
      'user-1',
      String(state?.activeProjectId || ''),
    );
    expect(project?.workspacePath).toBeTruthy();
    return String(project?.workspacePath || '');
  }

  function getConversationId(): string {
    const conversation = repo.getConversationByExternalChat(
      ChannelType.WEBCHAT,
      'default',
      'user-1',
    );
    expect(conversation?.id).toBeTruthy();
    return String(conversation?.id || '');
  }

  it('passes active project workspaceCwd to main-agent tool loop execution', async () => {
    dispatchWithFallbackMock
      .mockResolvedValueOnce({
        ok: true,
        text: '',
        provider: 'test-provider',
        model: 'test-model',
        functionCalls: [{ name: 'shell_execute', args: { command: 'echo from-loop' } }],
      })
      .mockResolvedValueOnce({
        ok: true,
        text: 'done',
        provider: 'test-provider',
        model: 'test-model',
      });

    const workspacePath = getActiveWorkspacePath();
    await service.handleInbound(
      ChannelType.WEBCHAT,
      'default',
      'Bitte pruefe kurz den aktuellen Stand',
      undefined,
      undefined,
      'user-1',
    );

    expect(dispatchSkillMock).toHaveBeenCalledWith(
      'shell_execute',
      { command: 'echo from-loop' },
      expect.objectContaining({
        workspaceCwd: workspacePath,
      }),
    );
    expect(dispatchWithFallbackMock).toHaveBeenCalledTimes(2);
  });

  it('passes active project workspaceCwd to /shell command execution', async () => {
    const workspacePath = getActiveWorkspacePath();
    await service.handleInbound(
      ChannelType.WEBCHAT,
      'default',
      '/shell echo smoke',
      undefined,
      undefined,
      'user-1',
    );

    expect(dispatchSkillMock).toHaveBeenCalledWith(
      'shell_execute',
      { command: 'echo smoke' },
      expect.objectContaining({
        workspaceCwd: workspacePath,
      }),
    );
  });

  it('passes active project workspaceCwd during approval replay', async () => {
    process.env.OPENCLAW_EXEC_APPROVALS_REQUIRED = 'true';
    const workspacePath = getActiveWorkspacePath();

    const blocked = await service.handleInbound(
      ChannelType.WEBCHAT,
      'default',
      '/shell echo smoke',
      undefined,
      undefined,
      'user-1',
    );
    const metadata = JSON.parse(String(blocked.agentMsg.metadata || '{}')) as {
      status?: string;
      approvalToken?: string;
    };
    expect(metadata.status).toBe('approval_required');
    expect(dispatchSkillMock).not.toHaveBeenCalled();

    dispatchWithFallbackMock.mockResolvedValueOnce({
      ok: true,
      text: 'approved-flow-finished',
      provider: 'test-provider',
      model: 'test-model',
    });
    await service.respondToolApproval({
      conversationId: getConversationId(),
      userId: 'user-1',
      approvalToken: String(metadata.approvalToken || ''),
      approved: true,
      toolFunctionName: 'shell_execute',
    });

    expect(dispatchSkillMock).toHaveBeenCalledWith(
      'shell_execute',
      { command: 'echo smoke' },
      expect.objectContaining({
        bypassApproval: true,
        workspaceCwd: workspacePath,
      }),
    );
  });
});
