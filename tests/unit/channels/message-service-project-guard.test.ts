import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelType } from '@/shared/domain/types';
import { MessageService } from '@/server/channels/messages/service';
import { SqliteMessageRepository } from '@/server/channels/messages/sqliteMessageRepository';

const dispatchWithFallbackMock = vi.hoisted(() =>
  vi.fn(async () => ({
    ok: true,
    text: 'guard-bypassed-model-response',
    provider: 'test-provider',
    model: 'test-model',
  })),
);

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

describe('MessageService project guard', () => {
  let repo: SqliteMessageRepository;
  let service: MessageService;

  beforeEach(() => {
    repo = new SqliteMessageRepository(':memory:');
    service = new MessageService(repo);
    dispatchWithFallbackMock.mockClear();
  });

  function enablePersonaConversation() {
    const conversation = repo.getOrCreateConversation(
      ChannelType.WEBCHAT,
      'default',
      undefined,
      'user-1',
    );
    repo.updatePersonaId(conversation.id, 'persona-1', 'user-1');
    return repo.getConversation(conversation.id, 'user-1')!;
  }

  it('returns approval_required when build intent has no active project', async () => {
    enablePersonaConversation();

    const response = await service.handleInbound(
      ChannelType.WEBCHAT,
      'default',
      'Erstelle mir eine Next.js WebApp fuer Notizen',
      undefined,
      undefined,
      'user-1',
    );

    const metadata = JSON.parse(String(response.agentMsg.metadata || '{}')) as {
      status?: string;
      approvalToken?: string;
      approvalToolFunction?: string;
    };
    expect(metadata.status).toBe('approval_required');
    expect(metadata.approvalToolFunction).toBe('project_workspace_guard');
    expect(typeof metadata.approvalToken).toBe('string');
    expect(dispatchWithFallbackMock).not.toHaveBeenCalled();
  });

  it('bypasses guard for non-build intent', async () => {
    enablePersonaConversation();

    const response = await service.handleInbound(
      ChannelType.WEBCHAT,
      'default',
      'Wie geht es dir?',
      undefined,
      undefined,
      'user-1',
    );

    const metadata = JSON.parse(String(response.agentMsg.metadata || '{}')) as { status?: string };
    expect(metadata.status).not.toBe('approval_required');
  });

  it('allows subsequent build intent after project guard approval', async () => {
    const conversation = enablePersonaConversation();

    const blocked = await service.handleInbound(
      ChannelType.WEBCHAT,
      'default',
      'Erstelle mir eine React App mit Login',
      undefined,
      undefined,
      'user-1',
    );
    const blockedMetadata = JSON.parse(String(blocked.agentMsg.metadata || '{}')) as {
      approvalToken?: string;
    };
    const approvalToken = String(blockedMetadata.approvalToken || '');
    expect(approvalToken).not.toBe('');

    const approval = await service.respondToolApproval({
      conversationId: conversation.id,
      userId: 'user-1',
      approvalToken,
      approved: true,
      toolFunctionName: 'project_workspace_guard',
    });
    expect(approval.status).toBe('approved');

    const state = repo.getConversationProjectState?.(conversation.id, 'user-1');
    expect(state?.guardApprovedWithoutProject).toBe(true);

    dispatchWithFallbackMock.mockClear();
    const allowed = await service.handleInbound(
      ChannelType.WEBCHAT,
      'default',
      'Erstelle mir eine React App mit Login',
      undefined,
      undefined,
      'user-1',
    );
    const allowedMetadata = JSON.parse(String(allowed.agentMsg.metadata || '{}')) as {
      status?: string;
    };
    expect(allowedMetadata.status).not.toBe('approval_required');
  });

  it('resets no-project guard approval after /project new', async () => {
    const conversation = enablePersonaConversation();

    const blocked = await service.handleInbound(
      ChannelType.WEBCHAT,
      'default',
      'Erstelle ein neues API Projekt',
      undefined,
      undefined,
      'user-1',
    );
    const blockedMetadata = JSON.parse(String(blocked.agentMsg.metadata || '{}')) as {
      approvalToken?: string;
    };
    await service.respondToolApproval({
      conversationId: conversation.id,
      userId: 'user-1',
      approvalToken: String(blockedMetadata.approvalToken || ''),
      approved: true,
      toolFunctionName: 'project_workspace_guard',
    });

    const before = repo.getConversationProjectState?.(conversation.id, 'user-1');
    expect(before?.guardApprovedWithoutProject).toBe(true);

    const createdProject = repo.createProject?.({
      userId: 'user-1',
      personaId: 'persona-1',
      name: 'Notes',
      workspacePath: 'D:/tmp/project-notes',
    });
    repo.setActiveProjectForConversation?.(conversation.id, 'user-1', createdProject?.id || null);

    const after = repo.getConversationProjectState?.(conversation.id, 'user-1');
    expect(after?.activeProjectId).toBeTruthy();
    expect(after?.guardApprovedWithoutProject).toBe(false);
  });
});
