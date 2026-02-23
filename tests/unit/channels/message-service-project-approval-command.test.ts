import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelType } from '@/shared/domain/types';
import { MessageService } from '@/server/channels/messages/service';
import { SqliteMessageRepository } from '@/server/channels/messages/sqliteMessageRepository';

const dispatchWithFallbackMock = vi.hoisted(() =>
  vi.fn(async () => ({
    ok: true,
    text: 'approval-command-model-response',
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

describe('MessageService /approve and /deny command flow', () => {
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

  it('approves project guard token via /approve <token>', async () => {
    enablePersonaConversation();

    const blocked = await service.handleInbound(
      ChannelType.WEBCHAT,
      'default',
      'Erstelle mir eine Next.js App mit Login und Dashboard',
      undefined,
      undefined,
      'user-1',
    );
    const blockedMetadata = JSON.parse(String(blocked.agentMsg.metadata || '{}')) as {
      approvalToken?: string;
    };
    const token = String(blockedMetadata.approvalToken || '');
    expect(token).not.toBe('');

    const approved = await service.handleInbound(
      ChannelType.WEBCHAT,
      'default',
      `/approve ${token}`,
      undefined,
      undefined,
      'user-1',
    );
    expect(String(approved.agentMsg.content).toLowerCase()).toContain('freigabe gespeichert');

    dispatchWithFallbackMock.mockClear();
    const allowed = await service.handleInbound(
      ChannelType.WEBCHAT,
      'default',
      'Erstelle mir eine Next.js App mit Login und Dashboard',
      undefined,
      undefined,
      'user-1',
    );
    const metadata = JSON.parse(String(allowed.agentMsg.metadata || '{}')) as { status?: string };
    expect(metadata.status).not.toBe('approval_required');
  });

  it('denies project guard token via /deny <token>', async () => {
    enablePersonaConversation();

    const blocked = await service.handleInbound(
      ChannelType.WEBCHAT,
      'default',
      'Bau mir eine React App mit Auth',
      undefined,
      undefined,
      'user-1',
    );
    const blockedMetadata = JSON.parse(String(blocked.agentMsg.metadata || '{}')) as {
      approvalToken?: string;
    };
    const token = String(blockedMetadata.approvalToken || '');

    const denied = await service.handleInbound(
      ChannelType.WEBCHAT,
      'default',
      `/deny ${token}`,
      undefined,
      undefined,
      'user-1',
    );
    expect(String(denied.agentMsg.content).toLowerCase()).toContain('abgelehnt');

    const blockedAgain = await service.handleInbound(
      ChannelType.WEBCHAT,
      'default',
      'Bau mir eine React App mit Auth',
      undefined,
      undefined,
      'user-1',
    );
    const blockedAgainMetadata = JSON.parse(String(blockedAgain.agentMsg.metadata || '{}')) as {
      status?: string;
    };
    expect(blockedAgainMetadata.status).toBe('approval_required');
  });

  it('returns token-not-found for unknown /approve tokens', async () => {
    enablePersonaConversation();
    const result = await service.handleInbound(
      ChannelType.WEBCHAT,
      'default',
      '/approve invalid-token',
      undefined,
      undefined,
      'user-1',
    );
    expect(String(result.agentMsg.content).toLowerCase()).toContain('nicht gefunden');
  });
});
