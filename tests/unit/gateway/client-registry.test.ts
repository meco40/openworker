import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { WebSocket } from 'ws';

// Client registry uses globalThis singleton — import after potential cleanup
import { getClientRegistry, type GatewayClient } from '../../../src/server/gateway/client-registry';

function makeMockSocket(): WebSocket {
  return {
    readyState: 1, // WebSocket.OPEN
    OPEN: 1,
    bufferedAmount: 0,
    send: vi.fn(),
    close: vi.fn(),
  } as unknown as WebSocket;
}

function makeClient(overrides: Partial<GatewayClient> = {}): GatewayClient {
  return {
    socket: makeMockSocket(),
    connId: 'conn-1',
    userId: 'user-a',
    connectedAt: Date.now(),
    subscriptions: new Set(),
    requestCount: 0,
    requestWindowStart: Date.now(),
    ...overrides,
  };
}

describe('ClientRegistry', () => {
  let registry: ReturnType<typeof getClientRegistry>;

  beforeEach(() => {
    registry = getClientRegistry();
    // Clean up any existing clients
    for (const c of registry.getAll()) {
      registry.unregister(c.connId);
    }
  });

  it('registers and retrieves a client by connId', () => {
    const client = makeClient();
    registry.register(client);
    expect(registry.get('conn-1')).toBe(client);
  });

  it('returns undefined for unknown connId', () => {
    expect(registry.get('nonexistent')).toBeUndefined();
  });

  it('tracks connection count', () => {
    expect(registry.connectionCount).toBe(0);
    registry.register(makeClient({ connId: 'c1' }));
    registry.register(makeClient({ connId: 'c2' }));
    expect(registry.connectionCount).toBe(2);
  });

  it('indexes clients by userId', () => {
    registry.register(makeClient({ connId: 'c1', userId: 'alice' }));
    registry.register(makeClient({ connId: 'c2', userId: 'alice' }));
    registry.register(makeClient({ connId: 'c3', userId: 'bob' }));

    const aliceClients = registry.getByUserId('alice');
    expect(aliceClients).toHaveLength(2);
    expect(aliceClients.map((c) => c.connId).sort()).toEqual(['c1', 'c2']);

    expect(registry.getByUserId('bob')).toHaveLength(1);
    expect(registry.getByUserId('nobody')).toEqual([]);
  });

  it('unregisters a client and cleans user index', () => {
    registry.register(makeClient({ connId: 'c1', userId: 'alice' }));
    const removed = registry.unregister('c1');
    expect(removed?.connId).toBe('c1');
    expect(registry.get('c1')).toBeUndefined();
    expect(registry.getByUserId('alice')).toEqual([]);
    expect(registry.connectionCount).toBe(0);
  });

  it('returns undefined when unregistering unknown connId', () => {
    expect(registry.unregister('ghost')).toBeUndefined();
  });

  it('getAll returns all registered clients', () => {
    registry.register(makeClient({ connId: 'a' }));
    registry.register(makeClient({ connId: 'b' }));
    expect(registry.getAll()).toHaveLength(2);
  });

  it('getUserConnectionCount returns per-user count', () => {
    registry.register(makeClient({ connId: 'c1', userId: 'alice' }));
    registry.register(makeClient({ connId: 'c2', userId: 'alice' }));
    expect(registry.getUserConnectionCount('alice')).toBe(2);
    expect(registry.getUserConnectionCount('nobody')).toBe(0);
  });

  it('getUserCount counts distinct users', () => {
    registry.register(makeClient({ connId: 'c1', userId: 'alice' }));
    registry.register(makeClient({ connId: 'c2', userId: 'bob' }));
    registry.register(makeClient({ connId: 'c3', userId: 'alice' }));
    expect(registry.getUserCount()).toBe(2);
  });

  it('preserves user index when one of multiple connections removed', () => {
    registry.register(makeClient({ connId: 'c1', userId: 'alice' }));
    registry.register(makeClient({ connId: 'c2', userId: 'alice' }));
    registry.unregister('c1');
    expect(registry.getByUserId('alice')).toHaveLength(1);
    expect(registry.getUserConnectionCount('alice')).toBe(1);
  });
});
