import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  let personasRootPath = '';

  beforeEach(() => {
    personasRootPath = path.resolve(
      '.local',
      `personas.project.command.${Date.now()}.${Math.random().toString(36).slice(2)}`,
    );
    process.env.PERSONAS_ROOT_PATH = personasRootPath;
    repo = new SqliteMessageRepository(':memory:');
    service = new MessageService(repo);
    dispatchWithFallbackMock.mockClear();
  });

  afterEach(() => {
    delete process.env.PERSONAS_ROOT_PATH;
    if (personasRootPath) {
      fs.rmSync(personasRootPath, { recursive: true, force: true });
      personasRootPath = '';
    }
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

  it('deletes project and removes its workspace folder', async () => {
    activatePersona();

    await service.handleInbound(
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
    const stateBefore = repo.getConversationProjectState?.(String(conversation?.id), 'user-1');
    const project = repo.getProjectByIdOrSlug?.(
      'persona-1',
      'user-1',
      String(stateBefore?.activeProjectId || ''),
    );
    expect(project).not.toBeNull();
    expect(fs.existsSync(String(project?.workspacePath || ''))).toBe(true);

    const deleted = await service.handleInbound(
      ChannelType.WEBCHAT,
      'default',
      `/project delete ${project?.slug}`,
      undefined,
      undefined,
      'user-1',
    );
    expect(String(deleted.agentMsg.content).toLowerCase()).toContain('gel');

    const stateAfter = repo.getConversationProjectState?.(String(conversation?.id), 'user-1');
    expect(stateAfter?.activeProjectId).toBeNull();
    expect(
      repo.getProjectByIdOrSlug?.('persona-1', 'user-1', String(project?.id || '')),
    ).toBeNull();
    expect(fs.existsSync(String(project?.workspacePath || ''))).toBe(false);
  });

  it('allows selecting project by list index for /project use', async () => {
    activatePersona();
    await service.handleInbound(
      ChannelType.WEBCHAT,
      'default',
      '/project new Notes',
      undefined,
      undefined,
      'user-1',
    );
    await service.handleInbound(
      ChannelType.WEBCHAT,
      'default',
      '/project new Docs',
      undefined,
      undefined,
      'user-1',
    );

    const useByIndex = await service.handleInbound(
      ChannelType.WEBCHAT,
      'default',
      '/project use 1',
      undefined,
      undefined,
      'user-1',
    );
    expect(String(useByIndex.agentMsg.content)).toContain('Docs');
  });

  it('allows deleting project by list index for /project delete', async () => {
    activatePersona();
    await service.handleInbound(
      ChannelType.WEBCHAT,
      'default',
      '/project new Notes',
      undefined,
      undefined,
      'user-1',
    );

    const listed = await service.handleInbound(
      ChannelType.WEBCHAT,
      'default',
      '/project list',
      undefined,
      undefined,
      'user-1',
    );
    expect(String(listed.agentMsg.content)).toContain('1. Notes');

    const deleted = await service.handleInbound(
      ChannelType.WEBCHAT,
      'default',
      '/project delete 1',
      undefined,
      undefined,
      'user-1',
    );
    expect(String(deleted.agentMsg.content).toLowerCase()).toContain('projekt gelöscht');
  });
});
