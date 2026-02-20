import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type TestGlobals = typeof globalThis & {
  __channelHealthMonitorHandle?: { stop: () => void };
};

describe('channel health monitor', () => {
  const previousEnabled = process.env.CHANNEL_HEALTH_MONITOR_ENABLED;
  const previousInterval = process.env.CHANNEL_HEALTH_MONITOR_INTERVAL_MS;
  const previousThreshold = process.env.CHANNEL_HEALTH_MONITOR_FAILURE_THRESHOLD;
  const previousCooldown = process.env.CHANNEL_HEALTH_MONITOR_REPAIR_COOLDOWN_MS;
  const previousBridgeUrl = process.env.WHATSAPP_BRIDGE_URL;

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();

    process.env.CHANNEL_HEALTH_MONITOR_ENABLED = 'true';
    process.env.CHANNEL_HEALTH_MONITOR_INTERVAL_MS = '10';
    process.env.CHANNEL_HEALTH_MONITOR_FAILURE_THRESHOLD = '2';
    process.env.CHANNEL_HEALTH_MONITOR_REPAIR_COOLDOWN_MS = '0';
    process.env.WHATSAPP_BRIDGE_URL = 'http://bridge.local';

    const globals = globalThis as TestGlobals;
    globals.__channelHealthMonitorHandle?.stop();
    globals.__channelHealthMonitorHandle = undefined;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();

    const globals = globalThis as TestGlobals;
    globals.__channelHealthMonitorHandle?.stop();
    globals.__channelHealthMonitorHandle = undefined;

    if (previousEnabled === undefined) delete process.env.CHANNEL_HEALTH_MONITOR_ENABLED;
    else process.env.CHANNEL_HEALTH_MONITOR_ENABLED = previousEnabled;
    if (previousInterval === undefined) delete process.env.CHANNEL_HEALTH_MONITOR_INTERVAL_MS;
    else process.env.CHANNEL_HEALTH_MONITOR_INTERVAL_MS = previousInterval;
    if (previousThreshold === undefined) delete process.env.CHANNEL_HEALTH_MONITOR_FAILURE_THRESHOLD;
    else process.env.CHANNEL_HEALTH_MONITOR_FAILURE_THRESHOLD = previousThreshold;
    if (previousCooldown === undefined) delete process.env.CHANNEL_HEALTH_MONITOR_REPAIR_COOLDOWN_MS;
    else process.env.CHANNEL_HEALTH_MONITOR_REPAIR_COOLDOWN_MS = previousCooldown;
    if (previousBridgeUrl === undefined) delete process.env.WHATSAPP_BRIDGE_URL;
    else process.env.WHATSAPP_BRIDGE_URL = previousBridgeUrl;
  });

  it('attempts webhook refresh after repeated failures and marks account connected on success', async () => {
    const registerBridgeWebhook = vi.fn(async () => ({ ok: true }));
    const probeBridgeHealth = vi.fn(async () => ({ ok: false, status: 503 }));
    const listBridgeAccounts = vi.fn(() => [
      { accountId: 'sales', pairingStatus: 'connected', peerName: null, lastSeenAt: null },
    ]);
    const upsertBridgeAccount = vi.fn();
    const resolveBridgeAccountSecret = vi.fn(() => 'secret');

    vi.doMock('../../../src/server/channels/pairing/bridge', () => ({
      registerBridgeWebhook,
      probeBridgeHealth,
    }));
    vi.doMock('../../../src/server/channels/pairing/bridgeAccounts', () => ({
      listBridgeAccounts,
      upsertBridgeAccount,
      resolveBridgeAccountSecret,
    }));

    const { startChannelHealthMonitor } = await import('../../../src/server/channels/healthMonitor');
    const monitor = startChannelHealthMonitor();

    await vi.advanceTimersByTimeAsync(50);

    expect(probeBridgeHealth).toHaveBeenCalled();
    expect(registerBridgeWebhook).toHaveBeenCalledWith({
      channel: 'whatsapp',
      accountId: 'sales',
      webhookSecret: 'secret',
    });
    expect(upsertBridgeAccount).toHaveBeenCalledWith('whatsapp', {
      accountId: 'sales',
      pairingStatus: 'connected',
      touchLastSeen: true,
    });

    monitor.stop();
  });
});

