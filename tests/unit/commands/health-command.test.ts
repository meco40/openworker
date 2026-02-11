import { afterEach, describe, expect, it, vi } from 'vitest';

type SecuritySnapshot = {
  checks: Array<{ id: string; status: 'ok' | 'warning' | 'critical'; detail: string }>;
  summary: { ok: number; warning: number; critical: number };
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  delete process.env.WHATSAPP_BRIDGE_URL;
  delete process.env.IMESSAGE_BRIDGE_URL;
  delete process.env.MESSAGES_DB_PATH;
  globalThis.__credentialStore = undefined;
});

describe('runHealthCommand', () => {
  it('returns skipped integration checks when bridge URLs are not configured', async () => {
    const { runHealthCommand } = await import('../../../src/commands/healthCommand');
    const report = await runHealthCommand();

    expect(report.summary.skipped).toBeGreaterThanOrEqual(2);
    expect(report.checks.find((c) => c.id === 'integration.whatsapp_bridge')?.status).toBe('skipped');
    expect(report.checks.find((c) => c.id === 'integration.imessage_bridge')?.status).toBe('skipped');
    expect(['ok', 'degraded', 'critical']).toContain(report.status);
  });

  it('marks report as degraded when a configured bridge health check fails', async () => {
    process.env.MESSAGES_DB_PATH = ':memory:';
    process.env.WHATSAPP_BRIDGE_URL = 'http://bridge.local';
    const { getCredentialStore } = await import('../../../src/server/channels/credentials');
    getCredentialStore().setCredential('whatsapp', 'pairing_status', 'connected');

    const { runHealthCommand } = await import('../../../src/commands/healthCommand');
    const report = await runHealthCommand({
      fetchImpl: vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: false }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    });

    const bridgeCheck = report.checks.find((c) => c.id === 'integration.whatsapp_bridge');
    expect(bridgeCheck?.status).toBe('warning');
    expect(report.status).toBe('degraded');
  });

  it('skips optional bridge checks when bridge URL exists but channel is not paired', async () => {
    process.env.WHATSAPP_BRIDGE_URL = 'http://bridge.local';

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const { runHealthCommand } = await import('../../../src/commands/healthCommand');
    const report = await runHealthCommand({ fetchImpl: fetchMock });

    const bridgeCheck = report.checks.find((c) => c.id === 'integration.whatsapp_bridge');
    expect(bridgeCheck?.status).toBe('skipped');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('marks report as critical when security snapshot contains critical findings', async () => {
    vi.doMock('../../../src/server/security/status', () => ({
      buildSecurityStatusSnapshot: (): SecuritySnapshot => ({
        checks: [{ id: 'firewall', status: 'critical', detail: 'high-risk enabled' }],
        summary: { ok: 0, warning: 0, critical: 1 },
      }),
    }));

    const { runHealthCommand } = await import('../../../src/commands/healthCommand');
    const report = await runHealthCommand();

    expect(report.checks.find((c) => c.id === 'security.snapshot')?.status).toBe('critical');
    expect(report.status).toBe('critical');
  });

  it('marks report as critical when a configured bridge check times out', async () => {
    process.env.MESSAGES_DB_PATH = ':memory:';
    process.env.WHATSAPP_BRIDGE_URL = 'http://bridge.local';
    const { getCredentialStore } = await import('../../../src/server/channels/credentials');
    getCredentialStore().setCredential('whatsapp', 'pairing_status', 'connected');
    const timeoutError = new Error('operation timed out') as Error & { name: string };
    timeoutError.name = 'AbortError';

    const { runHealthCommand } = await import('../../../src/commands/healthCommand');
    const report = await runHealthCommand({
      fetchImpl: vi.fn().mockRejectedValue(timeoutError),
      timeoutMs: 25,
    });

    const bridgeCheck = report.checks.find((c) => c.id === 'integration.whatsapp_bridge');
    expect(bridgeCheck?.status).toBe('critical');
    expect(report.status).toBe('critical');
  });
});
