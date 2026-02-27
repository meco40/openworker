import { describe, expect, it, vi } from 'vitest';
import { mockUserContext, registerOpsRouteLifecycleHooks } from './ops-routes.harness';

describe('ops routes', () => {
  registerOpsRouteLifecycleHooks();

  it('returns 401 for all ops routes when user context is unavailable', async () => {
    mockUserContext(null);

    const instancesRoute = await import('../../../../app/api/ops/instances/route');
    const sessionsRoute = await import('../../../../app/api/ops/sessions/route');
    const nodesRoute = await import('../../../../app/api/ops/nodes/route');
    const agentsRoute = await import('../../../../app/api/ops/agents/route');

    const responses = await Promise.all([
      instancesRoute.GET(new Request('http://localhost/api/ops/instances')),
      sessionsRoute.GET(new Request('http://localhost/api/ops/sessions')),
      nodesRoute.GET(new Request('http://localhost/api/ops/nodes')),
      agentsRoute.GET(new Request('http://localhost/api/ops/agents')),
    ]);

    for (const response of responses) {
      const payload = (await response.json()) as { ok: boolean; error: string };
      expect(response.status).toBe(401);
      expect(payload.ok).toBe(false);
      expect(payload.error).toContain('Unauthorized');
    }
  });

  it('returns user-scoped websocket instance summaries with clamped limit', async () => {
    mockUserContext({ userId: 'ops-user', authenticated: true });

    const getByUserId = vi.fn().mockReturnValue([
      {
        connId: 'conn-a',
        userId: 'ops-user',
        connectedAt: 1_700_000_000_000,
        subscriptions: new Set(['rooms:1', 'chat:1']),
        requestCount: 4,
        requestWindowStart: 1_700_000_001_000,
        seq: 14,
      },
      {
        connId: 'conn-b',
        userId: 'ops-user',
        connectedAt: 1_700_000_002_000,
        subscriptions: new Set(['chat:2']),
        requestCount: 2,
        requestWindowStart: 1_700_000_002_500,
        seq: 7,
      },
    ]);

    vi.doMock('../../../../src/server/gateway/client-registry', () => ({
      getClientRegistry: () => ({
        connectionCount: 5,
        getUserCount: () => 3,
        getByUserId,
      }),
    }));

    const route = await import('../../../../app/api/ops/instances/route');
    const response = await route.GET(new Request('http://localhost/api/ops/instances?limit=0'));
    const payload = (await response.json()) as {
      ok: boolean;
      instances: {
        global: { connectionCount: number; userCount: number };
        currentUser: {
          connectionCount: number;
          connections: Array<{
            connId: string;
            connectedAt: string;
            subscriptionCount: number;
            requestCount: number;
            seq: number;
          }>;
        };
      };
    };

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(getByUserId).toHaveBeenCalledWith('ops-user');
    expect(payload.instances.global.connectionCount).toBe(5);
    expect(payload.instances.global.userCount).toBe(3);
    expect(payload.instances.currentUser.connectionCount).toBe(2);
    expect(payload.instances.currentUser.connections).toHaveLength(1);
    expect(payload.instances.currentUser.connections[0]).toMatchObject({
      connId: 'conn-a',
      subscriptionCount: 2,
      requestCount: 4,
      seq: 14,
    });
  });
});
