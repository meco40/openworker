import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';

import type { GatewayClient } from '@/server/gateway/client-registry';
import { getClientRegistry } from '@/server/gateway/client-registry';
import { runGatewayKeepaliveSweep } from '@/server/gateway/keepalive';

type MockSocket = WebSocket & {
  ping: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
};

function makeMockSocket(overrides: Partial<MockSocket> = {}): MockSocket {
  return {
    OPEN: 1,
    readyState: 1,
    ping: vi.fn(),
    terminate: vi.fn(),
    ...overrides,
  } as unknown as MockSocket;
}

function makeClient(
  connId: string,
  userId: string,
  socket: MockSocket,
  isAlive: boolean,
): GatewayClient {
  return {
    socket,
    connId,
    userId,
    connectedAt: Date.now(),
    subscriptions: new Set(),
    requestCount: 0,
    requestWindowStart: Date.now(),
    seq: 0,
    isAlive,
  };
}

describe('gateway keepalive', () => {
  const registry = getClientRegistry();

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const client of registry.getAll()) {
      registry.unregister(client.connId);
    }
  });

  it('terminates stale connections and pings healthy ones', () => {
    const staleSocket = makeMockSocket();
    const healthySocket = makeMockSocket();
    registry.register(makeClient('conn-stale', 'user-a', staleSocket, false));
    const healthyClient = makeClient('conn-healthy', 'user-b', healthySocket, true);
    registry.register(healthyClient);

    runGatewayKeepaliveSweep();

    expect(staleSocket.terminate).toHaveBeenCalledTimes(1);
    expect(staleSocket.ping).not.toHaveBeenCalled();

    expect(healthySocket.ping).toHaveBeenCalledTimes(1);
    expect(healthyClient.isAlive).toBe(false);
    expect(healthySocket.terminate).not.toHaveBeenCalled();
  });

  it('skips non-open sockets', () => {
    const closedSocket = makeMockSocket({ readyState: 3 });
    const closedClient = makeClient('conn-closed', 'user-a', closedSocket, true);
    registry.register(closedClient);

    runGatewayKeepaliveSweep();

    expect(closedSocket.ping).not.toHaveBeenCalled();
    expect(closedSocket.terminate).not.toHaveBeenCalled();
    expect(closedClient.isAlive).toBe(true);
  });
});
