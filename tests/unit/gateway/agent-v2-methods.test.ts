import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GatewayClient } from '@/server/gateway/client-registry';
import type { RequestFrame } from '@/server/gateway/protocol';
import type { MockProcedure } from '../../helpers/mockProcedure';

function makeClient(userId = 'user-v2'): GatewayClient {
  return {
    socket: {
      readyState: 1,
      OPEN: 1,
      bufferedAmount: 0,
      send: vi.fn<MockProcedure>(),
      close: vi.fn<MockProcedure>(),
    } as unknown as GatewayClient['socket'],
    connId: 'conn-v2',
    userId,
    protocol: 'v2',
    connectedAt: Date.now(),
    subscriptions: new Set(),
    requestCount: 0,
    requestWindowStart: Date.now(),
    seq: 0,
  };
}

function makeRequest(
  method: string,
  params?: Record<string, unknown>,
  id: string | number = 'req-v2-1',
): RequestFrame {
  return { type: 'req', id, method, params };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('gateway agent v2 methods', () => {
  it('dispatches session.start with persona and conversation payload in v2 namespace', async () => {
    vi.resetModules();

    const startSession = vi.fn<
      () => Promise<{ session: { id: string; userId: string }; events: never[] }>
    >(async () => ({
      session: { id: 's-1', userId: 'user-v2' },
      events: [],
    }));
    vi.doMock('../../../src/server/agent-v2/runtime', () => ({
      getAgentV2SessionManager: () => ({
        startSession,
        enqueueInput: vi.fn<MockProcedure>(),
        enqueueSteer: vi.fn<MockProcedure>(),
        enqueueFollowUp: vi.fn<MockProcedure>(),
        enqueueApprovalResponse: vi.fn<MockProcedure>(),
        enqueueAbort: vi.fn<MockProcedure>(),
        getSession: vi.fn<MockProcedure>(),
        listSessions: vi.fn<MockProcedure>(),
        replaySessionEvents: vi.fn<MockProcedure>(),
      }),
    }));
    vi.doMock('../../../src/server/channels/messages/runtime', () => ({
      getMessageRepository: vi.fn<() => Record<string, unknown>>(() => ({})),
      getMessageService: vi.fn<MockProcedure>(() => ({
        getConversation: vi.fn<MockProcedure>(),
        getOrCreateConversation: vi.fn<MockProcedure>(),
        setPersonaId: vi.fn<MockProcedure>(),
      })),
    }));
    vi.doMock('../../../src/server/personas/personaRepository', () => ({
      getPersonaRepository: () => ({
        getPersona: vi.fn<() => { id: string }>(() => ({ id: 'persona-1' })),
      }),
    }));
    vi.doMock('../../../src/server/gateway/broadcast', () => ({
      broadcastToUser: vi.fn<MockProcedure>(),
    }));

    const { dispatchMethod } = await import('@/server/gateway/method-router');
    await import('@/server/gateway/methods/agent-v2/registerMethods');

    const sent: unknown[] = [];
    await dispatchMethod(
      makeRequest('agent.v2.session.start', {
        title: 'Test',
        personaId: 'persona-1',
        conversationId: 'conv-1',
      }),
      makeClient(),
      (frame) => sent.push(frame),
      'v2',
    );

    expect(startSession).toHaveBeenCalledWith({
      userId: 'user-v2',
      title: 'Test',
      personaId: 'persona-1',
      conversationId: 'conv-1',
    });
    expect(sent[0]).toMatchObject({
      type: 'res',
      ok: true,
      payload: {
        session: { id: 's-1', userId: 'user-v2' },
      },
    });
  });

  it('implements swarm persistence methods', async () => {
    vi.resetModules();
    vi.stubEnv('AGENT_ROOM_ENABLED', 'true');

    const createAgentRoomSwarm = vi.fn<MockProcedure>(() => ({
      id: 'swarm-1',
      conversationId: 'conv-1',
      userId: 'user-v2',
      sessionId: null,
      title: 'Title',
      task: 'Task',
      leadPersonaId: 'persona-1',
      units: [
        { personaId: 'persona-1', role: 'lead' },
        { personaId: 'persona-2', role: 'specialist' },
      ],
      status: 'idle',
      currentPhase: 'analysis',
      consensusScore: 0,
      holdFlag: false,
      artifact: '',
      artifactHistory: [],
      friction: { level: 'low', confidence: 0, hold: false, reasons: [], updatedAt: 'now' },
      lastSeq: 0,
      createdAt: 'now',
      updatedAt: 'now',
    }));
    const listAgentRoomSwarms = vi.fn<MockProcedure>(() => [
      createAgentRoomSwarm.mock.results[0]?.value,
    ]);
    const getAgentRoomSwarm = vi.fn<MockProcedure>(
      () => createAgentRoomSwarm.mock.results[0]?.value,
    );
    const updateAgentRoomSwarm = vi.fn<MockProcedure>(() => ({
      ...createAgentRoomSwarm.mock.results[0]?.value,
      status: 'running',
      updatedAt: 'later',
    }));
    const deleteAgentRoomSwarm = vi.fn<() => boolean>(() => true);

    vi.doMock('../../../src/server/agent-v2/runtime', () => ({
      getAgentV2SessionManager: () => ({
        startSession: vi.fn<MockProcedure>(),
        enqueueInput: vi.fn<MockProcedure>(),
        enqueueSteer: vi.fn<MockProcedure>(),
        enqueueFollowUp: vi.fn<MockProcedure>(),
        enqueueApprovalResponse: vi.fn<MockProcedure>(),
        enqueueAbort: vi.fn<MockProcedure>(),
        getSession: vi.fn<MockProcedure>(),
        listSessions: vi.fn<MockProcedure>(),
        replaySessionEvents: vi.fn<MockProcedure>(),
      }),
    }));
    vi.doMock('../../../src/server/channels/messages/runtime', () => ({
      getMessageRepository: vi.fn<MockProcedure>(() => ({
        createAgentRoomSwarm,
        listAgentRoomSwarms,
        getAgentRoomSwarm,
        updateAgentRoomSwarm,
        deleteAgentRoomSwarm,
      })),
      getMessageService: vi.fn<MockProcedure>(() => ({
        getConversation: vi.fn<() => { id: string; personaId: null }>(() => ({
          id: 'conv-1',
          personaId: null,
        })),
        isAgentRoomConversation: vi.fn<() => boolean>(() => true),
        getOrCreateConversation: vi.fn<() => { id: string; personaId: null }>(() => ({
          id: 'conv-1',
          personaId: null,
        })),
        setPersonaId: vi.fn<MockProcedure>(),
      })),
    }));
    vi.doMock('../../../src/server/personas/personaRepository', () => ({
      getPersonaRepository: () => ({
        getPersona: vi.fn<() => { id: string }>(() => ({ id: 'persona-1' })),
      }),
    }));
    vi.doMock('../../../src/server/gateway/broadcast', () => ({
      broadcastToUser: vi.fn<MockProcedure>(),
    }));

    const { dispatchMethod } = await import('@/server/gateway/method-router');
    await import('@/server/gateway/methods/agent-v2/registerMethods');

    const createFrames: unknown[] = [];
    await dispatchMethod(
      makeRequest('agent.v2.swarm.create', {
        title: 'Title',
        task: 'Task',
        leadPersonaId: 'persona-1',
        units: [
          { personaId: 'persona-1', role: 'lead' },
          { personaId: 'persona-2', role: 'specialist' },
        ],
        conversationId: 'conv-1',
      }),
      makeClient(),
      (frame) => createFrames.push(frame),
      'v2',
    );
    expect(createAgentRoomSwarm).toHaveBeenCalled();
    expect(createFrames[0]).toMatchObject({ type: 'res', ok: true });

    const listFrames: unknown[] = [];
    await dispatchMethod(
      makeRequest('agent.v2.swarm.list', { limit: 10 }),
      makeClient(),
      (frame) => listFrames.push(frame),
      'v2',
    );
    expect(listAgentRoomSwarms).toHaveBeenCalledWith('user-v2', 10);
    expect(listFrames[0]).toMatchObject({ type: 'res', ok: true });

    const getFrames: unknown[] = [];
    await dispatchMethod(
      makeRequest('agent.v2.swarm.get', { id: 'swarm-1' }),
      makeClient(),
      (frame) => getFrames.push(frame),
      'v2',
    );
    expect(getAgentRoomSwarm).toHaveBeenCalledWith('swarm-1', 'user-v2');
    expect(getFrames[0]).toMatchObject({ type: 'res', ok: true });

    const updateFrames: unknown[] = [];
    await dispatchMethod(
      makeRequest('agent.v2.swarm.update', { id: 'swarm-1', status: 'running' }),
      makeClient(),
      (frame) => updateFrames.push(frame),
      'v2',
    );
    expect(updateAgentRoomSwarm).toHaveBeenCalled();
    expect(updateFrames[0]).toMatchObject({ type: 'res', ok: true });

    const deleteFrames: unknown[] = [];
    await dispatchMethod(
      makeRequest('agent.v2.swarm.delete', { id: 'swarm-1' }),
      makeClient(),
      (frame) => deleteFrames.push(frame),
      'v2',
    );
    expect(deleteAgentRoomSwarm).toHaveBeenCalledWith('swarm-1', 'user-v2');
    expect(deleteFrames[0]).toMatchObject({ type: 'res', ok: true });
  });

  it('dispatches v2 methods via default namespace', async () => {
    vi.resetModules();
    vi.doMock('../../../src/server/channels/messages/runtime', () => ({
      getMessageRepository: vi.fn<() => Record<string, unknown>>(() => ({})),
      getMessageService: vi.fn<MockProcedure>(() => ({
        getConversation: vi.fn<MockProcedure>(),
        getOrCreateConversation: vi.fn<MockProcedure>(),
        setPersonaId: vi.fn<MockProcedure>(),
      })),
    }));
    vi.doMock('../../../src/server/personas/personaRepository', () => ({
      getPersonaRepository: () => ({ getPersona: vi.fn<MockProcedure>() }),
    }));
    vi.doMock('../../../src/server/agent-v2/runtime', () => ({
      getAgentV2SessionManager: () => ({
        startSession: vi.fn<MockProcedure>(),
        enqueueInput: vi.fn<MockProcedure>(),
        enqueueSteer: vi.fn<MockProcedure>(),
        enqueueFollowUp: vi.fn<MockProcedure>(),
        enqueueApprovalResponse: vi.fn<MockProcedure>(),
        enqueueAbort: vi.fn<MockProcedure>(),
        getSession: vi.fn<MockProcedure>(),
        listSessions: vi.fn<MockProcedure>(),
        replaySessionEvents: vi.fn<MockProcedure>(),
      }),
    }));
    vi.doMock('../../../src/server/gateway/broadcast', () => ({
      broadcastToUser: vi.fn<MockProcedure>(),
    }));

    await import('@/server/gateway/methods/agent-v2/registerMethods');
    const { dispatchMethod } = await import('@/server/gateway/method-router');
    const sent: unknown[] = [];

    await dispatchMethod(
      makeRequest('agent.v2.session.list', { limit: 5 }),
      makeClient(),
      (frame) => sent.push(frame),
      'v2',
    );

    expect(sent[0]).toMatchObject({
      type: 'res',
      ok: true,
    });
  });
});
