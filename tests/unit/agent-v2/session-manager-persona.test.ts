import { describe, expect, it, vi } from 'vitest';

describe('AgentV2SessionManager persona binding', () => {
  it('binds selected persona to conversation before session create', async () => {
    vi.resetModules();

    const setPersonaId = vi.fn();
    vi.doMock('../../../src/server/channels/messages/runtime', () => ({
      getMessageService: () => ({
        getConversation: vi.fn(() => ({
          id: 'conv-1',
          userId: 'user-1',
          personaId: null,
        })),
        getOrCreateConversation: vi.fn(() => ({
          id: 'conv-1',
          userId: 'user-1',
          personaId: null,
        })),
        setPersonaId,
      }),
    }));
    vi.doMock('../../../src/server/personas/personaRepository', () => ({
      getPersonaRepository: () => ({ getPersona: vi.fn(() => ({ id: 'persona-1' })) }),
    }));

    const now = '2026-02-24T00:00:00.000Z';
    const repository = {
      recoverRunningCommandsOnStartup: vi.fn(() => ({ recoveredCommands: 0 })),
      pruneExpiredEvents: vi.fn(),
      createSession: vi.fn(() => ({
        session: {
          id: 'session-1',
          userId: 'user-1',
          conversationId: 'conv-1',
          status: 'idle',
          revision: 0,
          lastSeq: 0,
          queueDepth: 0,
          runningCommandId: null,
          lastError: null,
          createdAt: now,
          updatedAt: now,
          completedAt: null,
        },
        events: [],
      })),
      appendEvent: vi.fn(),
      hasQueuedAbort: vi.fn(() => false),
      countQueuedCommands: vi.fn(() => 0),
      enqueueCommand: vi.fn(),
      startNextQueuedCommand: vi.fn(),
      completeCommand: vi.fn(),
      getSession: vi.fn(),
      listSessions: vi.fn(() => []),
      replayEvents: vi.fn(() => []),
      close: vi.fn(),
    };
    const extensionHost = {
      refresh: vi.fn(),
      runHooks: vi.fn(async () => []),
      stopAll: vi.fn(),
    };

    const { AgentV2SessionManager } = await import('@/server/agent-v2/sessionManager');
    const manager = new AgentV2SessionManager(repository as never, extensionHost as never);
    const result = await manager.startSession({
      userId: 'user-1',
      title: 'Session',
      personaId: 'persona-1',
      conversationId: 'conv-1',
    });

    expect(setPersonaId).toHaveBeenCalledWith('conv-1', 'persona-1', 'user-1');
    expect(repository.createSession).toHaveBeenCalledWith({
      userId: 'user-1',
      conversationId: 'conv-1',
      status: 'idle',
    });
    expect(result.session.id).toBe('session-1');
  });

  it('throws INVALID_REQUEST when persona does not exist', async () => {
    vi.resetModules();

    vi.doMock('../../../src/server/channels/messages/runtime', () => ({
      getMessageService: () => ({
        getConversation: vi.fn(() => ({
          id: 'conv-1',
          userId: 'user-1',
          personaId: null,
        })),
        getOrCreateConversation: vi.fn(() => ({
          id: 'conv-1',
          userId: 'user-1',
          personaId: null,
        })),
        setPersonaId: vi.fn(),
      }),
    }));
    vi.doMock('../../../src/server/personas/personaRepository', () => ({
      getPersonaRepository: () => ({ getPersona: vi.fn(() => null) }),
    }));

    const repository = {
      recoverRunningCommandsOnStartup: vi.fn(() => ({ recoveredCommands: 0 })),
      pruneExpiredEvents: vi.fn(),
      createSession: vi.fn(),
      close: vi.fn(),
    };
    const extensionHost = {
      refresh: vi.fn(),
      runHooks: vi.fn(async () => []),
      stopAll: vi.fn(),
    };
    const { AgentV2SessionManager } = await import('@/server/agent-v2/sessionManager');
    const manager = new AgentV2SessionManager(repository as never, extensionHost as never);

    await expect(
      manager.startSession({
        userId: 'user-1',
        title: 'Session',
        personaId: 'missing-persona',
        conversationId: 'conv-1',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });
});
