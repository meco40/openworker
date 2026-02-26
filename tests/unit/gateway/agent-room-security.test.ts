import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GatewayClient } from '@/server/gateway/client-registry';
import type { RequestFrame } from '@/server/gateway/protocol';

function makeClient(userId = 'user-v2'): GatewayClient {
  return {
    socket: {
      readyState: 1,
      OPEN: 1,
      bufferedAmount: 0,
      send: vi.fn(),
      close: vi.fn(),
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

function req(
  method: string,
  params?: Record<string, unknown>,
  id: string | number = 'req-agent-room-security',
): RequestFrame {
  return { type: 'req', id, method, params };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('agent room security guards', () => {
  it('rejects swarm RPC when server kill switch is disabled', async () => {
    vi.resetModules();
    vi.stubEnv('AGENT_ROOM_ENABLED', 'false');

    vi.doMock('../../../src/server/channels/messages/runtime', () => ({
      getMessageRepository: vi.fn(() => ({})),
      getMessageService: vi.fn(() => ({
        getConversation: vi.fn(),
        getOrCreateConversation: vi.fn(),
        setPersonaId: vi.fn(),
      })),
    }));
    vi.doMock('../../../src/server/personas/personaRepository', () => ({
      getPersonaRepository: () => ({ getPersona: vi.fn() }),
    }));
    vi.doMock('../../../src/server/agent-v2/runtime', () => ({
      getAgentV2SessionManager: () => ({
        startSession: vi.fn(),
        enqueueInput: vi.fn(),
        enqueueSteer: vi.fn(),
        enqueueFollowUp: vi.fn(),
        enqueueApprovalResponse: vi.fn(),
        enqueueAbort: vi.fn(),
        getSession: vi.fn(),
        listSessions: vi.fn(),
        replaySessionEvents: vi.fn(),
      }),
    }));
    vi.doMock('../../../src/server/gateway/broadcast', () => ({
      broadcastToUser: vi.fn(),
    }));

    await import('@/server/gateway/methods/agent-v2/registerMethods');
    const { dispatchMethod } = await import('@/server/gateway/method-router');
    const sent: unknown[] = [];

    await dispatchMethod(
      req('agent.v2.swarm.list'),
      makeClient(),
      (frame) => sent.push(frame),
      'v2',
    );

    expect(sent[0]).toMatchObject({
      type: 'res',
      ok: false,
      error: { code: 'UNAVAILABLE' },
    });
  });

  it('rejects oversized task payloads in swarm.create', async () => {
    vi.resetModules();
    vi.stubEnv('AGENT_ROOM_ENABLED', 'true');
    const createAgentRoomSwarm = vi.fn();

    vi.doMock('../../../src/server/channels/messages/runtime', () => ({
      getMessageRepository: vi.fn(() => ({
        createAgentRoomSwarm,
        listAgentRoomSwarms: vi.fn(),
        getAgentRoomSwarm: vi.fn(),
        updateAgentRoomSwarm: vi.fn(),
        deleteAgentRoomSwarm: vi.fn(),
      })),
      getMessageService: vi.fn(() => ({
        getConversation: vi.fn(() => ({ id: 'conv-1', personaId: null })),
        getOrCreateConversation: vi.fn(() => ({ id: 'conv-1', personaId: null })),
        setPersonaId: vi.fn(),
      })),
    }));
    vi.doMock('../../../src/server/personas/personaRepository', () => ({
      getPersonaRepository: () => ({ getPersona: vi.fn(() => ({ id: 'persona-1' })) }),
    }));
    vi.doMock('../../../src/server/agent-v2/runtime', () => ({
      getAgentV2SessionManager: () => ({
        startSession: vi.fn(),
        enqueueInput: vi.fn(),
        enqueueSteer: vi.fn(),
        enqueueFollowUp: vi.fn(),
        enqueueApprovalResponse: vi.fn(),
        enqueueAbort: vi.fn(),
        getSession: vi.fn(),
        listSessions: vi.fn(),
        replaySessionEvents: vi.fn(),
      }),
    }));
    vi.doMock('../../../src/server/gateway/broadcast', () => ({
      broadcastToUser: vi.fn(),
    }));

    await import('@/server/gateway/methods/agent-v2/registerMethods');
    const { dispatchMethod } = await import('@/server/gateway/method-router');
    const sent: unknown[] = [];
    const hugeTask = 'x'.repeat(8_100);

    await dispatchMethod(
      req('agent.v2.swarm.create', {
        title: 'Title',
        task: hugeTask,
        leadPersonaId: 'persona-1',
        units: [{ personaId: 'persona-1', role: 'lead' }],
      }),
      makeClient(),
      (frame) => sent.push(frame),
      'v2',
    );

    expect(createAgentRoomSwarm).not.toHaveBeenCalled();
    expect(sent[0]).toMatchObject({
      type: 'res',
      ok: false,
      error: { code: 'INVALID_REQUEST' },
    });
  });

  it('rejects swarm.create when fewer than two distinct personas are provided', async () => {
    vi.resetModules();
    vi.stubEnv('AGENT_ROOM_ENABLED', 'true');
    const createAgentRoomSwarm = vi.fn();

    vi.doMock('../../../src/server/channels/messages/runtime', () => ({
      getMessageRepository: vi.fn(() => ({
        createAgentRoomSwarm,
        listAgentRoomSwarms: vi.fn(),
        getAgentRoomSwarm: vi.fn(),
        updateAgentRoomSwarm: vi.fn(),
        deleteAgentRoomSwarm: vi.fn(),
      })),
      getMessageService: vi.fn(() => ({
        getConversation: vi.fn(() => ({ id: 'conv-1', personaId: null })),
        getOrCreateConversation: vi.fn(() => ({ id: 'conv-1', personaId: null })),
        setPersonaId: vi.fn(),
      })),
    }));
    vi.doMock('../../../src/server/personas/personaRepository', () => ({
      getPersonaRepository: () => ({ getPersona: vi.fn(() => ({ id: 'persona-1' })) }),
    }));
    vi.doMock('../../../src/server/agent-v2/runtime', () => ({
      getAgentV2SessionManager: () => ({
        startSession: vi.fn(),
        enqueueInput: vi.fn(),
        enqueueSteer: vi.fn(),
        enqueueFollowUp: vi.fn(),
        enqueueApprovalResponse: vi.fn(),
        enqueueAbort: vi.fn(),
        getSession: vi.fn(),
        listSessions: vi.fn(),
        replaySessionEvents: vi.fn(),
      }),
    }));
    vi.doMock('../../../src/server/gateway/broadcast', () => ({
      broadcastToUser: vi.fn(),
    }));

    await import('@/server/gateway/methods/agent-v2/registerMethods');
    const { dispatchMethod } = await import('@/server/gateway/method-router');
    const sent: unknown[] = [];

    await dispatchMethod(
      req('agent.v2.swarm.create', {
        title: 'Title',
        task: 'Task',
        leadPersonaId: 'persona-1',
        units: [{ personaId: 'persona-1', role: 'lead' }],
      }),
      makeClient(),
      (frame) => sent.push(frame),
      'v2',
    );

    expect(createAgentRoomSwarm).not.toHaveBeenCalled();
    expect(sent[0]).toMatchObject({
      type: 'res',
      ok: false,
      error: { code: 'INVALID_REQUEST' },
    });
  });
});
