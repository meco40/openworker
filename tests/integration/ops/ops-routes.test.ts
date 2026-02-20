import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type MockUserContext = { userId: string; authenticated: boolean } | null;

function mockUserContext(context: MockUserContext): void {
  vi.doMock('../../../src/server/auth/userContext', () => ({
    resolveRequestUserContext: vi.fn().mockResolvedValue(context),
  }));
}

describe('ops routes', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('returns 401 for all ops routes when user context is unavailable', async () => {
    mockUserContext(null);

    const instancesRoute = await import('../../../app/api/ops/instances/route');
    const sessionsRoute = await import('../../../app/api/ops/sessions/route');
    const nodesRoute = await import('../../../app/api/ops/nodes/route');
    const agentsRoute = await import('../../../app/api/ops/agents/route');

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

    vi.doMock('../../../src/server/gateway/client-registry', () => ({
      getClientRegistry: () => ({
        connectionCount: 5,
        getUserCount: () => 3,
        getByUserId,
      }),
    }));

    const route = await import('../../../app/api/ops/instances/route');
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

  it('returns conversation sessions filtered by query and bounded by clamped limit', async () => {
    mockUserContext({ userId: 'ops-user', authenticated: true });

    const listConversations = vi.fn().mockReturnValue([
      {
        id: 'conv-1',
        channelType: 'WebChat',
        externalChatId: 'default',
        userId: 'ops-user',
        title: 'Ops Daily',
        modelOverride: null,
        personaId: 'persona-1',
        createdAt: '2026-02-20T00:00:00.000Z',
        updatedAt: '2026-02-20T00:01:00.000Z',
      },
      {
        id: 'conv-2',
        channelType: 'Telegram',
        externalChatId: 'chat-22',
        userId: 'ops-user',
        title: 'Personal Notes',
        modelOverride: null,
        personaId: 'persona-2',
        createdAt: '2026-02-20T00:02:00.000Z',
        updatedAt: '2026-02-20T00:03:00.000Z',
      },
      {
        id: 'conv-3',
        channelType: 'Slack',
        externalChatId: 'ops-incident-room',
        userId: 'ops-user',
        title: 'Incident Room',
        modelOverride: null,
        personaId: null,
        createdAt: '2026-02-20T00:04:00.000Z',
        updatedAt: '2026-02-20T00:05:00.000Z',
      },
    ]);

    vi.doMock('../../../src/server/channels/messages/runtime', () => ({
      getMessageService: () => ({
        listConversations,
      }),
    }));

    const route = await import('../../../app/api/ops/sessions/route');
    const response = await route.GET(
      new Request('http://localhost/api/ops/sessions?limit=9999&q=ops'),
    );
    const payload = (await response.json()) as {
      ok: boolean;
      query: { q: string; limit: number };
      sessions: Array<{ id: string }>;
    };

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(listConversations).toHaveBeenCalledWith('ops-user', 200);
    expect(payload.query).toEqual({ q: 'ops', limit: 200 });
    expect(payload.sessions.map((session) => session.id)).toEqual(['conv-1', 'conv-3']);
  });

  it('returns node summary from health/doctor, channel state and room/automation metrics', async () => {
    mockUserContext({ userId: 'ops-user', authenticated: true });

    const runHealthCommand = vi.fn().mockResolvedValue({
      status: 'ok',
      checks: [{ id: 'db', status: 'ok' }],
      summary: { ok: 1, warning: 0, critical: 0, skipped: 0 },
      generatedAt: '2026-02-20T10:00:00.000Z',
    });
    const runDoctorCommand = vi.fn().mockResolvedValue({
      status: 'degraded',
      checks: [{ id: 'db', status: 'ok' }],
      findings: [{ id: 'bridge', severity: 'warning' }],
      recommendations: ['Check bridge'],
      generatedAt: '2026-02-20T10:00:10.000Z',
    });

    vi.doMock('../../../src/commands/healthCommand', () => ({
      runHealthCommand,
    }));
    vi.doMock('../../../src/commands/doctorCommand', () => ({
      runDoctorCommand,
    }));
    vi.doMock('../../../src/server/channels/messages/runtime', () => ({
      getMessageRepository: () => ({
        listChannelBindings: () => [
          {
            channel: 'telegram',
            status: 'connected',
            externalPeerId: 'chat-1',
            peerName: 'ops',
            transport: 'webhook',
            lastSeenAt: '2026-02-20T10:00:00.000Z',
          },
        ],
      }),
    }));
    vi.doMock('../../../src/server/automation/runtime', () => ({
      getAutomationService: () => ({
        getMetrics: () => ({
          activeRules: 2,
          queuedRuns: 1,
          runningRuns: 1,
          deadLetterRuns: 0,
          leaseAgeSeconds: 4,
        }),
      }),
    }));
    vi.doMock('../../../src/server/rooms/runtime', () => ({
      getRoomRepository: () => ({
        getMetrics: () => ({
          totalRooms: 3,
          runningRooms: 1,
          totalMembers: 7,
          totalMessages: 23,
        }),
      }),
    }));

    const route = await import('../../../app/api/ops/nodes/route');
    const response = await route.GET(
      new Request('http://localhost/api/ops/nodes?memoryDiagnostics=true'),
    );
    const payload = (await response.json()) as {
      ok: boolean;
      nodes: {
        health: { status: string };
        doctor: { status: string };
        channels: Array<{ channel: string }>;
        automation: { activeRules: number };
        rooms: { runningRooms: number };
      };
    };

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(runHealthCommand).toHaveBeenCalledWith({ memoryDiagnosticsEnabled: true });
    expect(runDoctorCommand).toHaveBeenCalledWith({ memoryDiagnosticsEnabled: true });
    expect(payload.nodes.health.status).toBe('ok');
    expect(payload.nodes.doctor.status).toBe('degraded');
    expect(payload.nodes.channels).toHaveLength(1);
    expect(payload.nodes.automation.activeRules).toBe(2);
    expect(payload.nodes.rooms.runningRooms).toBe(1);
  });

  it('returns personas, active room counts and a bounded runtime room snapshot', async () => {
    mockUserContext({ userId: 'ops-user', authenticated: true });

    vi.doMock('../../../src/server/personas/personaRepository', () => ({
      getPersonaRepository: () => ({
        listPersonas: () => [
          {
            id: 'persona-1',
            name: 'Nexus',
            emoji: '🤖',
            vibe: 'operator',
            preferredModelId: null,
            modelHubProfileId: null,
            memoryPersonaType: 'general',
            updatedAt: '2026-02-20T11:00:00.000Z',
          },
          {
            id: 'persona-2',
            name: 'Atlas',
            emoji: '🛰️',
            vibe: 'analysis',
            preferredModelId: null,
            modelHubProfileId: null,
            memoryPersonaType: 'general',
            updatedAt: '2026-02-20T11:00:10.000Z',
          },
        ],
      }),
    }));

    vi.doMock('../../../src/server/rooms/runtime', () => ({
      getRoomService: () => ({
        listActiveRoomCountsByPersona: () => ({
          'persona-1': 2,
          'persona-2': 0,
        }),
      }),
      getRoomRepository: () => ({
        listRunningRooms: () => [
          {
            id: 'room-1',
            userId: 'ops-user',
            name: 'Ops Room',
            runState: 'running',
            goalMode: 'planning',
            routingProfileId: 'p1',
            description: null,
            createdAt: '2026-02-20T11:05:00.000Z',
            updatedAt: '2026-02-20T11:06:00.000Z',
          },
          {
            id: 'room-2',
            userId: 'ops-user',
            name: 'Warm Standby',
            runState: 'degraded',
            goalMode: 'simulation',
            routingProfileId: 'p1',
            description: null,
            createdAt: '2026-02-20T11:07:00.000Z',
            updatedAt: '2026-02-20T11:08:00.000Z',
          },
          {
            id: 'room-3',
            userId: 'other-user',
            name: 'Foreign',
            runState: 'running',
            goalMode: 'free',
            routingProfileId: 'p1',
            description: null,
            createdAt: '2026-02-20T11:09:00.000Z',
            updatedAt: '2026-02-20T11:10:00.000Z',
          },
        ],
        listMembers: (roomId: string) =>
          roomId === 'room-1'
            ? [{ personaId: 'persona-1' }, { personaId: 'persona-2' }]
            : [{ personaId: 'persona-1' }],
        listMemberRuntime: (roomId: string) =>
          roomId === 'room-1'
            ? [
                { personaId: 'persona-1', status: 'busy' },
                { personaId: 'persona-2', status: 'idle' },
              ]
            : [{ personaId: 'persona-1', status: 'paused' }],
        getActiveRoomRun: (roomId: string) =>
          roomId === 'room-1'
            ? {
                id: 'run-1',
                runState: 'running',
                leaseOwner: 'worker-a',
                leaseExpiresAt: '2026-02-20T11:12:00.000Z',
                heartbeatAt: '2026-02-20T11:11:55.000Z',
              }
            : {
                id: 'run-2',
                runState: 'degraded',
                leaseOwner: 'worker-b',
                leaseExpiresAt: '2026-02-20T11:12:30.000Z',
                heartbeatAt: '2026-02-20T11:12:05.000Z',
              },
      }),
    }));

    const route = await import('../../../app/api/ops/agents/route');
    const response = await route.GET(new Request('http://localhost/api/ops/agents?limit=0'));
    const payload = (await response.json()) as {
      ok: boolean;
      agents: {
        personas: Array<{ id: string; activeRoomCount: number }>;
        sampledRooms: Array<{
          roomId: string;
          runState: string;
          memberCount: number;
          runtimeByStatus: Record<string, number>;
        }>;
      };
    };

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.agents.personas).toEqual([
      expect.objectContaining({ id: 'persona-1', activeRoomCount: 2 }),
      expect.objectContaining({ id: 'persona-2', activeRoomCount: 0 }),
    ]);
    expect(payload.agents.sampledRooms).toHaveLength(1);
    expect(payload.agents.sampledRooms[0]).toMatchObject({
      roomId: 'room-1',
      runState: 'running',
      memberCount: 2,
      runtimeByStatus: {
        busy: 1,
        idle: 1,
      },
    });
  });
});
