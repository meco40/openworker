import { describe, expect, it, vi } from 'vitest';
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

function makeRequest(
  method: string,
  params?: Record<string, unknown>,
  id: string | number = 'req-v2-1',
): RequestFrame {
  return { type: 'req', id, method, params };
}

describe('gateway agent v2 methods', () => {
  it('dispatches agent.v2.session.start via v2 namespace', async () => {
    vi.resetModules();

    const startSession = vi.fn(async () => ({
      session: { id: 's-1', userId: 'user-v2' },
      events: [],
    }));
    vi.doMock('../../../src/server/agent-v2/runtime', () => ({
      getAgentV2SessionManager: () => ({
        startSession,
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

    const { dispatchMethod } = await import('@/server/gateway/method-router');
    await import('@/server/gateway/methods/agent-v2');

    const sent: unknown[] = [];
    await dispatchMethod(
      makeRequest('agent.v2.session.start', { title: 'Test' }),
      makeClient(),
      (frame) => sent.push(frame),
      'v2',
    );

    expect(startSession).toHaveBeenCalledWith({
      userId: 'user-v2',
      title: 'Test',
    });
    expect(sent[0]).toMatchObject({
      type: 'res',
      ok: true,
      payload: {
        session: { id: 's-1', userId: 'user-v2' },
      },
    });
  });

  it('does not expose v2 methods to v1 namespace', async () => {
    vi.resetModules();
    await import('@/server/gateway/methods/agent-v2');
    const { dispatchMethod } = await import('@/server/gateway/method-router');
    const sent: unknown[] = [];

    await dispatchMethod(
      makeRequest('agent.v2.session.start'),
      makeClient(),
      (frame) => sent.push(frame),
      'v1',
    );

    expect(sent[0]).toMatchObject({
      type: 'res',
      ok: false,
      error: {
        code: 'INVALID_REQUEST',
      },
    });
  });
});
