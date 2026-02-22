import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';

import { MAX_BUFFERED_BYTES } from '@/server/gateway/constants';
import type { GatewayClient } from '@/server/gateway/client-registry';
import { getClientRegistry } from '@/server/gateway/client-registry';
import {
  broadcast,
  broadcastToConnIds,
  broadcastToSubscribed,
  broadcastToUser,
} from '@/server/gateway/broadcast';

type MockSocket = WebSocket & {
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

function makeMockSocket(overrides: Partial<MockSocket> = {}): MockSocket {
  return {
    readyState: 1,
    OPEN: 1,
    bufferedAmount: 0,
    send: vi.fn(),
    close: vi.fn(),
    ...overrides,
  } as unknown as MockSocket;
}

function makeClient(connId: string, userId: string, socket: MockSocket): GatewayClient {
  return {
    socket,
    connId,
    userId,
    connectedAt: Date.now(),
    subscriptions: new Set(),
    requestCount: 0,
    requestWindowStart: Date.now(),
    seq: 0,
  };
}

function parseSentEvent(socket: MockSocket, callIndex = 0): Record<string, unknown> {
  const raw = socket.send.mock.calls[callIndex]?.[0];
  return JSON.parse(raw);
}

describe('gateway broadcast', () => {
  const registry = getClientRegistry();

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const client of registry.getAll()) {
      registry.unregister(client.connId);
    }
  });

  it('broadcast sends event to all connected clients with per-client seq', () => {
    const socketA = makeMockSocket();
    const socketB = makeMockSocket();
    const clientA = makeClient('conn-a', 'user-1', socketA);
    const clientB = makeClient('conn-b', 'user-2', socketB);
    registry.register(clientA);
    registry.register(clientB);

    broadcast('tick', { ts: 1 });
    broadcast('tick', { ts: 2 });

    expect(socketA.send).toHaveBeenCalledTimes(2);
    expect(socketB.send).toHaveBeenCalledTimes(2);
    expect(parseSentEvent(socketA)).toMatchObject({ type: 'event', event: 'tick', seq: 1 });
    expect(parseSentEvent(socketA, 1)).toMatchObject({ type: 'event', event: 'tick', seq: 2 });
    expect(parseSentEvent(socketB)).toMatchObject({ type: 'event', event: 'tick', seq: 1 });
    expect(parseSentEvent(socketB, 1)).toMatchObject({ type: 'event', event: 'tick', seq: 2 });
    expect(clientA.seq).toBe(2);
    expect(clientB.seq).toBe(2);
  });

  it('broadcastToUser targets only the selected user connections', () => {
    const socketA1 = makeMockSocket();
    const socketA2 = makeMockSocket();
    const socketB = makeMockSocket();
    registry.register(makeClient('conn-a1', 'user-a', socketA1));
    registry.register(makeClient('conn-a2', 'user-a', socketA2));
    registry.register(makeClient('conn-b', 'user-b', socketB));

    broadcastToUser('user-a', 'presence.update', { status: 'online' });

    expect(socketA1.send).toHaveBeenCalledTimes(1);
    expect(socketA2.send).toHaveBeenCalledTimes(1);
    expect(socketB.send).not.toHaveBeenCalled();
  });

  it('broadcastToSubscribed targets only subscribed clients', () => {
    const socketSub = makeMockSocket();
    const socketNoSub = makeMockSocket();
    const subClient = makeClient('conn-sub', 'user-a', socketSub);
    subClient.subscriptions.add('logs');
    registry.register(subClient);
    registry.register(makeClient('conn-nosub', 'user-b', socketNoSub));

    broadcastToSubscribed('logs', 'log.entry', { message: 'x' });

    expect(socketSub.send).toHaveBeenCalledTimes(1);
    expect(socketNoSub.send).not.toHaveBeenCalled();
  });

  it('broadcastToConnIds sends only to existing connection ids', () => {
    const socketA = makeMockSocket();
    const socketB = makeMockSocket();
    registry.register(makeClient('conn-a', 'user-a', socketA));
    registry.register(makeClient('conn-b', 'user-b', socketB));

    broadcastToConnIds(['conn-a', 'missing'], 'chat.message', { text: 'hi' });

    expect(socketA.send).toHaveBeenCalledTimes(1);
    expect(socketB.send).not.toHaveBeenCalled();
  });

  it('skips sockets that are not open', () => {
    const closedSocket = makeMockSocket({ readyState: 3 });
    registry.register(makeClient('conn-closed', 'user-a', closedSocket));

    broadcast('tick', { ts: 1 });

    expect(closedSocket.send).not.toHaveBeenCalled();
    expect(closedSocket.close).not.toHaveBeenCalled();
  });

  it('closes slow consumers with policy code', () => {
    const slowSocket = makeMockSocket({ bufferedAmount: MAX_BUFFERED_BYTES + 1 });
    registry.register(makeClient('conn-slow', 'user-a', slowSocket));

    broadcast('tick', { ts: 1 });

    expect(slowSocket.send).not.toHaveBeenCalled();
    expect(slowSocket.close).toHaveBeenCalledWith(1008, 'slow consumer');
  });

  it('swallows close errors when closing slow consumers', () => {
    const slowSocket = makeMockSocket({
      bufferedAmount: MAX_BUFFERED_BYTES + 1,
      close: vi.fn(() => {
        throw new Error('close failed');
      }),
    });
    registry.register(makeClient('conn-slow', 'user-a', slowSocket));

    expect(() => broadcast('tick', { ts: 1 })).not.toThrow();
    expect(slowSocket.send).not.toHaveBeenCalled();
  });

  it('closes socket on send errors and swallows close failures', () => {
    const unstableSocket = makeMockSocket({
      send: vi.fn(() => {
        throw new Error('send failed');
      }),
      close: vi.fn(() => {
        throw new Error('close failed');
      }),
    });
    registry.register(makeClient('conn-unstable', 'user-a', unstableSocket));

    expect(() => broadcast('tick', { ts: 1 })).not.toThrow();
    expect(unstableSocket.send).toHaveBeenCalledTimes(1);
    expect(unstableSocket.close).toHaveBeenCalledWith(1011, 'send error');
  });
});
