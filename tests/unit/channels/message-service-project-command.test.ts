import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelType } from '@/shared/domain/types';
import { MessageService } from '@/server/channels/messages/service';
import { SqliteMessageRepository } from '@/server/channels/messages/sqliteMessageRepository';

const dispatchWithFallbackMock = vi.hoisted(() =>
  vi.fn(async () => ({
    ok: true,
    text: 'fallback-chat-response',
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
          emoji: '🛠️',
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
              emoji: '🛠️',
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

describe('MessageService /project command flow', () => {
  let repo: SqliteMessageRepository;
  let service: MessageService;

  beforeEach(() => {
    repo = new SqliteMessageRepository(':memory:');
    service = new MessageService(repo);
    dispatchWithFallbackMock.mockClear();
  });

  function activatePersona(): void {
    const conversation = repo.getOrCreateConversation(
      ChannelType.WEBCHAT,
      'default',
      undefined,
      'user-1',
    );
    repo.updatePersonaId(conversation.id, 'persona-1', 'user-1');
  }

  it('creates a project and sets it active in the conversation', async () => {
    activatePersona();

    const projectResponse = await service.handleInbound(
      ChannelType.WEBCHAT,
      'default',
      '/project new Notes',
      undefined,
      undefined,
      'user-1',
    );

    const conversation = repo.getConversationByExternalChat(
      ChannelType.WEBCHAT,
      'default',
      'user-1',
    );
    expect(conversation).not.toBeNull();
    const projectState = repo.getConversationProjectState?.(String(conversation?.id), 'user-1');
    expect(projectState?.activeProjectId).toBeTruthy();
    expect(String(projectResponse.agentMsg.content).toLowerCase()).toContain('notes');
  });

  it('lists only projects for the active persona', async () => {
    activatePersona();
    await service.handleInbound(
      ChannelType.WEBCHAT,
      'default',
      '/project new Notes',
      undefined,
      undefined,
      'user-1',
    );

    repo.createProject?.({
      userId: 'user-1',
      personaId: 'persona-foreign',
      name: 'Foreign',
      workspacePath: 'D:/tmp/foreign',
    });

    const listed = await service.handleInbound(
      ChannelType.WEBCHAT,
      'default',
      '/project list',
      undefined,
      undefined,
      'user-1',
    );

    expect(String(listed.agentMsg.content)).toContain('Notes');
    expect(String(listed.agentMsg.content)).not.toContain('Foreign');
  });

  it('rejects project creation when no persona is active', async () => {
    const response = await service.handleInbound(
      ChannelType.WEBCHAT,
      'default',
      '/project new Notes',
      undefined,
      undefined,
      'user-1',
    );

    expect(String(response.agentMsg.content).toLowerCase()).toContain('persona');
  });
});
