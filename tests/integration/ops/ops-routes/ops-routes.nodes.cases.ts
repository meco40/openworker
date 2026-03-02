import { describe, expect, it, vi } from 'vitest';
import { mockUserContext, registerOpsRouteLifecycleHooks } from './ops-routes.harness';

describe('ops routes', () => {
  registerOpsRouteLifecycleHooks();

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

    vi.doMock('../../../../src/commands/healthCommand', () => ({
      runHealthCommand,
    }));
    vi.doMock('../../../../src/commands/doctorCommand', () => ({
      runDoctorCommand,
    }));
    vi.doMock('../../../../src/server/gateway/exec-approval-manager', () => ({
      listApprovedCommands,
    }));
    vi.doMock('../../../../src/server/personas/personaRepository', () => ({
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
    vi.doMock('../../../../src/server/channels/pairing/telegramCodePairing', () => ({
      getTelegramPairingSnapshot: () => ({
        status: 'awaiting_code',
        pendingChatId: 'chat-7',
        pendingExpiresAt: '2026-02-20T10:30:00.000Z',
        hasPending: true,
      }),
    }));
    vi.doMock('../../../../src/server/channels/messages/runtime', () => ({
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
    vi.doMock('../../../../src/server/automation/runtime', () => ({
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
    const route = await import('../../../../app/api/ops/nodes/route');
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

  it('clamps channel limit query values via shared parser', async () => {
    mockUserContext({ userId: 'ops-user', authenticated: true });

    vi.doMock('../../../../src/commands/healthCommand', () => ({
      runHealthCommand: vi.fn().mockResolvedValue({
        status: 'ok',
        checks: [],
        summary: { ok: 0, warning: 0, critical: 0, skipped: 0 },
        generatedAt: '2026-02-20T10:00:00.000Z',
      }),
    }));
    vi.doMock('../../../../src/commands/doctorCommand', () => ({
      runDoctorCommand: vi.fn().mockResolvedValue({
        status: 'ok',
        checks: [],
        findings: [],
        recommendations: [],
        generatedAt: '2026-02-20T10:00:00.000Z',
      }),
    }));
    vi.doMock('../../../../src/server/gateway/exec-approval-manager', () => ({
      listApprovedCommands: vi.fn().mockReturnValue([]),
    }));
    vi.doMock('../../../../src/server/personas/personaRepository', () => ({
      getPersonaRepository: () => ({
        listPersonas: () => [],
      }),
    }));
    vi.doMock('../../../../src/server/channels/pairing/telegramCodePairing', () => ({
      getTelegramPairingSnapshot: () => ({
        status: 'idle',
        pendingChatId: null,
        pendingExpiresAt: null,
        hasPending: false,
      }),
      rejectTelegramPendingPairingRequest: vi.fn().mockReturnValue(false),
    }));
    vi.doMock('../../../../src/server/channels/messages/runtime', () => ({
      getMessageRepository: () => ({
        listChannelBindings: () => [],
      }),
    }));
    vi.doMock('../../../../src/server/automation/runtime', () => ({
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

    const route = await import('../../../../app/api/ops/nodes/route');

    async function getChannelCount(url: string): Promise<number> {
      const response = await route.GET(new Request(url));
      const payload = (await response.json()) as {
        ok: boolean;
        nodes: { channels: unknown[] };
      };
      expect(response.status).toBe(200);
      expect(payload.ok).toBe(true);
      return payload.nodes.channels.length;
    }

    const defaultCount = await getChannelCount('http://localhost/api/ops/nodes');
    const invalidCount = await getChannelCount('http://localhost/api/ops/nodes?limit=invalid');
    const lowCount = await getChannelCount('http://localhost/api/ops/nodes?limit=0');
    const oneCount = await getChannelCount('http://localhost/api/ops/nodes?limit=1');
    const highCount = await getChannelCount('http://localhost/api/ops/nodes?limit=999999');

    expect(invalidCount).toBe(defaultCount);
    expect(lowCount).toBe(oneCount);
    expect(oneCount).toBe(1);
    expect(highCount).toBe(defaultCount);
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

    vi.doMock('../../../../src/commands/healthCommand', () => ({
      runHealthCommand: vi.fn().mockResolvedValue({
        status: 'ok',
        checks: [],
        summary: { ok: 1, warning: 0, critical: 0, skipped: 0 },
        generatedAt: '2026-02-20T10:00:00.000Z',
      }),
    }));
    vi.doMock('../../../../src/commands/doctorCommand', () => ({
      runDoctorCommand: vi.fn().mockResolvedValue({
        status: 'ok',
        checks: [],
        findings: [],
        recommendations: [],
        generatedAt: '2026-02-20T10:00:00.000Z',
      }),
    }));
    vi.doMock('../../../../src/server/channels/messages/runtime', () => ({
      getMessageRepository: () => ({
        listChannelBindings: () => [],
        updateChannelBindingPersona,
      }),
    }));
    vi.doMock('../../../../src/server/automation/runtime', () => ({
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
    vi.doMock('../../../../src/server/personas/personaRepository', () => ({
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
    vi.doMock('../../../../src/server/gateway/exec-approval-manager', () => ({
      listApprovedCommands: vi.fn().mockReturnValue([]),
      approveCommand,
      revokeCommand,
      clearApprovedCommands,
    }));
    vi.doMock('../../../../src/server/channels/pairing', () => ({
      isPairChannelType: (value: string) =>
        value === 'telegram' ||
        value === 'discord' ||
        value === 'slack' ||
        value === 'whatsapp' ||
        value === 'imessage',
      pairChannel,
      unpairChannel,
    }));
    vi.doMock('../../../../src/server/channels/pairing/bridgeAccounts', () => ({
      upsertBridgeAccount,
      normalizeBridgeAccountId,
      listBridgeAccounts: () => [],
    }));
    vi.doMock('../../../../src/server/channels/pairing/telegramCodePairing', () => ({
      getTelegramPairingSnapshot: () => ({
        status: 'idle',
        pendingChatId: null,
        pendingExpiresAt: null,
        hasPending: false,
      }),
      rejectTelegramPendingPairingRequest,
    }));

    const route = await import('../../../../app/api/ops/nodes/route');

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
});
