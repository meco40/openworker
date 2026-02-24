import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelType } from '@/shared/domain/types';
import { MessageService } from '@/server/channels/messages/service';
import { SqliteMessageRepository } from '@/server/channels/messages/sqliteMessageRepository';

const dispatchWithFallbackMock = vi.hoisted(() =>
  vi.fn(async () => ({
    ok: true,
    text: 'build-task-completed',
    provider: 'test-provider',
    model: 'test-model',
  })),
);
const dispatchSkillMock = vi.hoisted(() =>
  vi.fn(async () => ({ stdout: 'ok', stderr: '', exitCode: 0 })),
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

vi.mock('../../../src/server/skills/executeSkill', async () => {
  const actual = await vi.importActual('../../../src/server/skills/executeSkill');
  return {
    ...actual,
    dispatchSkill: dispatchSkillMock,
  };
});

vi.mock('@/skills/definitions', () => ({
  mapSkillsToTools: () => [],
}));

describe('MessageService project clarification flow', () => {
  let repo: SqliteMessageRepository;
  let service: MessageService;

  beforeEach(() => {
    repo = new SqliteMessageRepository(':memory:');
    service = new MessageService(repo);
    dispatchWithFallbackMock.mockClear();
    dispatchSkillMock.mockClear();
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

  it('asks once for project name when build intent has no active project', async () => {
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
    };
    expect(metadata.status).toBe('project_clarification_required');
    expect(dispatchWithFallbackMock).not.toHaveBeenCalled();
  });

  it('creates and activates project after clarification reply, then runs original task', async () => {
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
      status?: string;
    };
    expect(blockedMetadata.status).toBe('project_clarification_required');

    const continued = await service.handleInbound(
      ChannelType.WEBCHAT,
      'default',
      'Notes',
      undefined,
      undefined,
      'user-1',
    );

    expect(continued.agentMsg.content).toContain('Projekt automatisch erstellt und aktiviert');
    expect(continued.agentMsg.content).toContain('build-task-completed');
    expect(dispatchWithFallbackMock).toHaveBeenCalledTimes(1);

    const state = repo.getConversationProjectState?.(conversation.id, 'user-1');
    expect(state?.activeProjectId).toBeTruthy();
  });

  it('bypasses clarification for non-build intent', async () => {
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
    expect(metadata.status).not.toBe('project_clarification_required');
  });
});
