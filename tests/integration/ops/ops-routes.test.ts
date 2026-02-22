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
      query: {
        q: string;
        limit: number;
        activeMinutes: number | null;
        includeGlobalRequested: boolean;
        includeGlobalApplied: boolean;
        includeUnknown: boolean;
      };
      sessions: Array<{ id: string }>;
    };

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(listConversations).toHaveBeenCalledWith('ops-user', 200);
    expect(payload.query).toEqual({
      q: 'ops',
      limit: 200,
      activeMinutes: null,
      includeGlobalRequested: false,
      includeGlobalApplied: false,
      includeUnknown: true,
    });
    expect(payload.sessions.map((session) => session.id)).toEqual(['conv-3', 'conv-1']);
  });

  it('applies sessions advanced filters and global merge in unauthenticated legacy mode', async () => {
    mockUserContext({ userId: 'ops-user', authenticated: false });

    const now = Date.now();
    const freshIso = new Date(now - 5 * 60_000).toISOString();
    const staleIso = new Date(now - 3 * 60 * 60_000).toISOString();

    const listConversations = vi.fn((userId?: string, limit?: number) => {
      const own = [
        {
          id: 'conv-1',
          channelType: 'WebChat',
          externalChatId: 'default',
          userId: 'ops-user',
          title: 'Ops Personal',
          modelOverride: null,
          personaId: 'persona-1',
          createdAt: freshIso,
          updatedAt: freshIso,
        },
        {
          id: 'conv-2',
          channelType: 'Slack',
          externalChatId: 'incident',
          userId: 'ops-user',
          title: 'Old Incident',
          modelOverride: null,
          personaId: 'persona-2',
          createdAt: staleIso,
          updatedAt: staleIso,
        },
        {
          id: 'conv-3',
          channelType: 'Telegram',
          externalChatId: 'chat-3',
          userId: 'ops-user',
          title: 'Unknown Persona',
          modelOverride: null,
          personaId: null,
          createdAt: freshIso,
          updatedAt: freshIso,
        },
      ];

      const global = [
        {
          id: 'conv-4',
          channelType: 'Discord',
          externalChatId: 'global-1',
          userId: 'other-user',
          title: 'Global Ops',
          modelOverride: null,
          personaId: 'persona-9',
          createdAt: freshIso,
          updatedAt: freshIso,
        },
        own[0],
      ];

      const rows = userId ? own : global;
      if (typeof limit === 'number') {
        return rows.slice(0, limit);
      }
      return rows;
    });

    vi.doMock('../../../src/server/channels/messages/runtime', () => ({
      getMessageService: () => ({
        listConversations,
      }),
    }));

    const route = await import('../../../app/api/ops/sessions/route');
    const response = await route.GET(
      new Request(
        'http://localhost/api/ops/sessions?limit=200&activeMinutes=60&includeUnknown=0&includeGlobal=1',
      ),
    );

    const payload = (await response.json()) as {
      ok: boolean;
      query: {
        q: string;
        limit: number;
        activeMinutes: number | null;
        includeGlobalRequested: boolean;
        includeGlobalApplied: boolean;
        includeUnknown: boolean;
      };
      sessions: Array<{ id: string }>;
    };

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.query).toEqual({
      q: '',
      limit: 200,
      activeMinutes: 60,
      includeGlobalRequested: true,
      includeGlobalApplied: true,
      includeUnknown: false,
    });
    expect(listConversations).toHaveBeenCalledWith('ops-user', 200);
    expect(listConversations).toHaveBeenCalledWith(undefined, 200);
    expect(payload.sessions.map((session) => session.id)).toEqual(['conv-1', 'conv-4']);
  });

  it('returns node summary from health/doctor, channel state and automation metrics', async () => {
    mockUserContext({ userId: 'ops-user', authenticated: true });

    const listApprovedCommands = vi.fn().mockReturnValue([
      {
        fingerprint: 'fp-a',
        command: 'echo hello',
        updatedAt: '2026-02-20T10:00:20.000Z',
      },
    ]);

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
    vi.doMock('../../../src/server/gateway/exec-approval-manager', () => ({
      listApprovedCommands,
    }));
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
            updatedAt: '2026-02-20T10:00:30.000Z',
          },
        ],
      }),
    }));
    vi.doMock('../../../src/server/channels/pairing/telegramCodePairing', () => ({
      getTelegramPairingSnapshot: () => ({
        status: 'awaiting_code',
        pendingChatId: 'chat-7',
        pendingExpiresAt: '2026-02-20T10:30:00.000Z',
        hasPending: true,
      }),
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
            personaId: 'persona-1',
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
    const route = await import('../../../app/api/ops/nodes/route');
    const response = await route.GET(
      new Request('http://localhost/api/ops/nodes?memoryDiagnostics=true'),
    );
    const payload = (await response.json()) as {
      ok: boolean;
      nodes: {
        health: { status: string };
        doctor: { status: string };
        channels: Array<{ channel: string; supportsPairing: boolean; personaId: string | null }>;
        personas: Array<{ id: string }>;
        execApprovals: { total: number; items: Array<{ command: string }> };
        telegramPairing: { hasPending: boolean; pendingChatId: string | null };
        automation: { activeRules: number };
      };
    };

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(runHealthCommand).toHaveBeenCalledWith({ memoryDiagnosticsEnabled: true });
    expect(runDoctorCommand).toHaveBeenCalledWith({ memoryDiagnosticsEnabled: true });
    expect(payload.nodes.health.status).toBe('ok');
    expect(payload.nodes.doctor.status).toBe('degraded');
    expect(payload.nodes.channels.length).toBeGreaterThan(0);
    const telegramChannel = payload.nodes.channels.find((entry) => entry.channel === 'telegram');
    expect(telegramChannel).toMatchObject({
      channel: 'telegram',
      supportsPairing: true,
      personaId: 'persona-1',
    });
    expect(payload.nodes.personas).toEqual([expect.objectContaining({ id: 'persona-1' })]);
    expect(payload.nodes.execApprovals.total).toBe(1);
    expect(payload.nodes.execApprovals.items[0]).toEqual(
      expect.objectContaining({ command: 'echo hello' }),
    );
    expect(payload.nodes.telegramPairing).toEqual(
      expect.objectContaining({ hasPending: true, pendingChatId: 'chat-7' }),
    );
    expect(payload.nodes.automation.activeRules).toBe(2);
    expect(payload.nodes).not.toHaveProperty('rooms');
    expect(listApprovedCommands).toHaveBeenCalledTimes(1);
  });

  it('applies nodes mutation actions and returns updated snapshots', async () => {
    mockUserContext({ userId: 'ops-user', authenticated: true });

    const approveCommand = vi.fn();
    const revokeCommand = vi.fn().mockReturnValue(true);
    const clearApprovedCommands = vi.fn();
    const pairChannel = vi.fn().mockResolvedValue({
      status: 'connected',
      peerName: 'Ops Bridge',
      transport: 'webhook',
      accountId: 'default',
    });
    const unpairChannel = vi.fn().mockImplementation(async () => {});
    const upsertBridgeAccount = vi.fn().mockReturnValue('default');
    const normalizeBridgeAccountId = vi.fn((value?: string) => value || 'default');
    const rejectTelegramPendingPairingRequest = vi.fn().mockReturnValue(true);
    const updateChannelBindingPersona = vi.fn();

    vi.doMock('../../../src/commands/healthCommand', () => ({
      runHealthCommand: vi.fn().mockResolvedValue({
        status: 'ok',
        checks: [],
        summary: { ok: 1, warning: 0, critical: 0, skipped: 0 },
        generatedAt: '2026-02-20T10:00:00.000Z',
      }),
    }));
    vi.doMock('../../../src/commands/doctorCommand', () => ({
      runDoctorCommand: vi.fn().mockResolvedValue({
        status: 'ok',
        checks: [],
        findings: [],
        recommendations: [],
        generatedAt: '2026-02-20T10:00:00.000Z',
      }),
    }));
    vi.doMock('../../../src/server/channels/messages/runtime', () => ({
      getMessageRepository: () => ({
        listChannelBindings: () => [],
        updateChannelBindingPersona,
      }),
    }));
    vi.doMock('../../../src/server/automation/runtime', () => ({
      getAutomationService: () => ({
        getMetrics: () => ({
          activeRules: 0,
          queuedRuns: 0,
          runningRuns: 0,
          deadLetterRuns: 0,
          leaseAgeSeconds: null,
        }),
      }),
    }));
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
            updatedAt: '2026-02-20T10:00:00.000Z',
          },
        ],
      }),
    }));
    vi.doMock('../../../src/server/gateway/exec-approval-manager', () => ({
      listApprovedCommands: vi.fn().mockReturnValue([]),
      approveCommand,
      revokeCommand,
      clearApprovedCommands,
    }));
    vi.doMock('../../../src/server/channels/pairing', () => ({
      isPairChannelType: (value: string) =>
        value === 'telegram' ||
        value === 'discord' ||
        value === 'slack' ||
        value === 'whatsapp' ||
        value === 'imessage',
      pairChannel,
      unpairChannel,
    }));
    vi.doMock('../../../src/server/channels/pairing/bridgeAccounts', () => ({
      upsertBridgeAccount,
      normalizeBridgeAccountId,
      listBridgeAccounts: () => [],
    }));
    vi.doMock('../../../src/server/channels/pairing/telegramCodePairing', () => ({
      getTelegramPairingSnapshot: () => ({
        status: 'idle',
        pendingChatId: null,
        pendingExpiresAt: null,
        hasPending: false,
      }),
      rejectTelegramPendingPairingRequest,
    }));

    const route = await import('../../../app/api/ops/nodes/route');

    const approveResponse = await route.POST(
      new Request('http://localhost/api/ops/nodes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'exec.approve', command: 'echo hello' }),
      }),
    );
    expect(approveResponse.status).toBe(200);
    expect(approveCommand).toHaveBeenCalledWith('echo hello');

    const bindResponse = await route.POST(
      new Request('http://localhost/api/ops/nodes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'bindings.setPersona',
          channel: 'telegram',
          personaId: 'persona-1',
        }),
      }),
    );
    expect(bindResponse.status).toBe(200);
    expect(updateChannelBindingPersona).toHaveBeenCalledWith('ops-user', 'telegram', 'persona-1');

    const connectResponse = await route.POST(
      new Request('http://localhost/api/ops/nodes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'channels.connect',
          channel: 'telegram',
          token: 'secret-token',
        }),
      }),
    );
    expect(connectResponse.status).toBe(200);
    expect(pairChannel).toHaveBeenCalledWith('telegram', 'secret-token', undefined);

    const disconnectResponse = await route.POST(
      new Request('http://localhost/api/ops/nodes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'channels.disconnect',
          channel: 'telegram',
          accountId: 'default',
        }),
      }),
    );
    expect(disconnectResponse.status).toBe(200);
    expect(unpairChannel).toHaveBeenCalledWith('telegram', 'default');

    const rotateResponse = await route.POST(
      new Request('http://localhost/api/ops/nodes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'channels.rotateSecret',
          channel: 'whatsapp',
          accountId: 'default',
        }),
      }),
    );
    expect(rotateResponse.status).toBe(200);
    expect(normalizeBridgeAccountId).toHaveBeenCalledWith('default');
    expect(upsertBridgeAccount).toHaveBeenCalledTimes(1);

    const revokeResponse = await route.POST(
      new Request('http://localhost/api/ops/nodes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'exec.revoke', command: 'echo hello' }),
      }),
    );
    expect(revokeResponse.status).toBe(200);
    expect(revokeCommand).toHaveBeenCalledWith('echo hello');

    const rejectTelegramResponse = await route.POST(
      new Request('http://localhost/api/ops/nodes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'telegram.rejectPending' }),
      }),
    );
    expect(rejectTelegramResponse.status).toBe(200);
    expect(rejectTelegramPendingPairingRequest).toHaveBeenCalledTimes(1);

    const clearResponse = await route.POST(
      new Request('http://localhost/api/ops/nodes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'exec.clear' }),
      }),
    );
    const clearPayload = (await clearResponse.json()) as {
      ok: boolean;
      mutation: { action: string; cleared: boolean };
    };
    expect(clearResponse.status).toBe(200);
    expect(clearPayload.ok).toBe(true);
    expect(clearPayload.mutation).toEqual({
      action: 'exec.clear',
      cleared: true,
    });
    expect(clearApprovedCommands).toHaveBeenCalledTimes(1);
  });

  it('returns personas without room-runtime snapshots', async () => {
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

    const route = await import('../../../app/api/ops/agents/route');
    const response = await route.GET(new Request('http://localhost/api/ops/agents?limit=0'));
    const payload = (await response.json()) as {
      ok: boolean;
      agents: {
        personas: Array<{ id: string }>;
      };
    };

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.agents.personas).toEqual([
      expect.objectContaining({ id: 'persona-1' }),
      expect.objectContaining({ id: 'persona-2' }),
    ]);
    expect(payload.agents).not.toHaveProperty('sampledRooms');
    expect(payload.agents.personas[0]).not.toHaveProperty('activeRoomCount');
  });
});
