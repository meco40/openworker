import { describe, expect, it, vi } from 'vitest';
import type { MockProcedure } from '../../helpers/mockProcedure';

describe('AgentV2SessionManager persona binding', () => {
  it('binds selected persona to conversation before session create', async () => {
    vi.resetModules();

    const setPersonaId = vi.fn<MockProcedure>();
    vi.doMock('../../../src/server/channels/messages/runtime', () => ({
      getMessageService: () => ({
        getConversation: vi.fn<() => { id: string; userId: string; personaId: null }>(() => ({
          id: 'conv-1',
          userId: 'user-1',
          personaId: null,
        })),
        getOrCreateConversation: vi.fn<() => { id: string; userId: string; personaId: null }>(
          () => ({
            id: 'conv-1',
            userId: 'user-1',
            personaId: null,
          }),
        ),
        setPersonaId,
      }),
    }));
    vi.doMock('../../../src/server/personas/personaRepository', () => ({
      getPersonaRepository: () => ({
        getPersona: vi.fn<() => { id: string }>(() => ({ id: 'persona-1' })),
      }),
    }));

    const now = '2026-02-24T00:00:00.000Z';
    const repository = {
      recoverRunningCommandsOnStartup: vi.fn<() => { recoveredCommands: number }>(() => ({
        recoveredCommands: 0,
      })),
      pruneExpiredEvents: vi.fn<MockProcedure>(),
      createSession: vi.fn<MockProcedure>(() => ({
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
      appendEvent: vi.fn<MockProcedure>(),
      hasQueuedAbort: vi.fn<() => boolean>(() => false),
      countQueuedCommands: vi.fn<() => number>(() => 0),
      enqueueCommand: vi.fn<MockProcedure>(),
      startNextQueuedCommand: vi.fn<MockProcedure>(),
      completeCommand: vi.fn<MockProcedure>(),
      getSession: vi.fn<MockProcedure>(),
      listSessions: vi.fn<() => never[]>(() => []),
      replayEvents: vi.fn<() => never[]>(() => []),
      close: vi.fn<MockProcedure>(),
    };
    const extensionHost = {
      refresh: vi.fn<MockProcedure>(),
      runHooks: vi.fn<() => Promise<never[]>>(async () => []),
      stopAll: vi.fn<MockProcedure>(),
    };

    const { AgentV2SessionManager } = await import('@/server/agent-v2/session');
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
        getConversation: vi.fn<() => { id: string; userId: string; personaId: null }>(() => ({
          id: 'conv-1',
          userId: 'user-1',
          personaId: null,
        })),
        getOrCreateConversation: vi.fn<() => { id: string; userId: string; personaId: null }>(
          () => ({
            id: 'conv-1',
            userId: 'user-1',
            personaId: null,
          }),
        ),
        setPersonaId: vi.fn<MockProcedure>(),
      }),
    }));
    vi.doMock('../../../src/server/personas/personaRepository', () => ({
      getPersonaRepository: () => ({ getPersona: vi.fn<() => null>(() => null) }),
    }));

    const repository = {
      recoverRunningCommandsOnStartup: vi.fn<() => { recoveredCommands: number }>(() => ({
        recoveredCommands: 0,
      })),
      pruneExpiredEvents: vi.fn<MockProcedure>(),
      createSession: vi.fn<MockProcedure>(),
      close: vi.fn<MockProcedure>(),
    };
    const extensionHost = {
      refresh: vi.fn<MockProcedure>(),
      runHooks: vi.fn<() => Promise<never[]>>(async () => []),
      stopAll: vi.fn<MockProcedure>(),
    };
    const { AgentV2SessionManager } = await import('@/server/agent-v2/session');
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
