import { registerBridgeWebhook, probeBridgeHealth } from '@/server/channels/pairing/bridge';
import {
  listBridgeAccounts,
  resolveBridgeAccountSecret,
  upsertBridgeAccount,
  type BridgeChannel,
} from '@/server/channels/pairing/bridgeAccounts';

const DEFAULT_INTERVAL_MS = Number(process.env.CHANNEL_HEALTH_MONITOR_INTERVAL_MS || 60_000);
const DEFAULT_FAILURE_THRESHOLD = Number(process.env.CHANNEL_HEALTH_MONITOR_FAILURE_THRESHOLD || 3);
const DEFAULT_REPAIR_COOLDOWN_MS = Number(
  process.env.CHANNEL_HEALTH_MONITOR_REPAIR_COOLDOWN_MS || 5 * 60_000,
);

type FailureState = {
  failures: number;
  lastFailureAtMs: number;
  lastRepairAtMs: number;
};

type ChannelMonitorHandle = {
  stop: () => void;
};

declare global {
  var __channelHealthMonitorHandle: ChannelMonitorHandle | undefined;
}

function monitorEnabled(): boolean {
  return String(process.env.CHANNEL_HEALTH_MONITOR_ENABLED || 'true').toLowerCase() !== 'false';
}

function isBridgeConfigured(channel: BridgeChannel): boolean {
  const envName = channel === 'whatsapp' ? 'WHATSAPP_BRIDGE_URL' : 'IMESSAGE_BRIDGE_URL';
  return Boolean(process.env[envName]?.trim());
}

function keyFor(channel: BridgeChannel, accountId: string): string {
  return `${channel}:${accountId}`;
}

export function startChannelHealthMonitor(): ChannelMonitorHandle {
  if (globalThis.__channelHealthMonitorHandle) {
    return globalThis.__channelHealthMonitorHandle;
  }
  if (!monitorEnabled()) {
    return {
      stop: () => {
        // no-op
      },
    };
  }

  const failureByAccount = new Map<string, FailureState>();
  let stopped = false;
  let running = false;

  async function handleFailure(channel: BridgeChannel, accountId: string): Promise<void> {
    const key = keyFor(channel, accountId);
    const nowMs = Date.now();
    const state = failureByAccount.get(key) || {
      failures: 0,
      lastFailureAtMs: 0,
      lastRepairAtMs: 0,
    };
    state.failures += 1;
    state.lastFailureAtMs = nowMs;
    failureByAccount.set(key, state);

    if (state.failures < DEFAULT_FAILURE_THRESHOLD) {
      return;
    }
    if (nowMs - state.lastRepairAtMs < DEFAULT_REPAIR_COOLDOWN_MS) {
      return;
    }

    state.lastRepairAtMs = nowMs;
    const secret = resolveBridgeAccountSecret(channel, accountId);
    const refreshed = await registerBridgeWebhook({
      channel,
      accountId,
      webhookSecret: secret || undefined,
    });
    if (refreshed.ok) {
      failureByAccount.delete(key);
      upsertBridgeAccount(channel, {
        accountId,
        pairingStatus: 'connected',
        touchLastSeen: true,
      });
      console.warn(`[channel-health] repaired ${channel}/${accountId} via webhook refresh`);
      return;
    }

    upsertBridgeAccount(channel, {
      accountId,
      pairingStatus: 'error',
    });
    console.warn(`[channel-health] ${channel}/${accountId} remains unhealthy after repair attempt`);
  }

  async function checkChannel(channel: BridgeChannel): Promise<void> {
    if (!isBridgeConfigured(channel)) {
      return;
    }
    const accounts = listBridgeAccounts(channel).filter(
      (entry) => entry.pairingStatus === 'connected' || entry.pairingStatus === 'error',
    );
    for (const account of accounts) {
      try {
        const health = await probeBridgeHealth(channel);
        if (health.ok) {
          failureByAccount.delete(keyFor(channel, account.accountId));
          upsertBridgeAccount(channel, {
            accountId: account.accountId,
            pairingStatus: 'connected',
            peerName: health.peerName,
            touchLastSeen: true,
          });
          continue;
        }
        await handleFailure(channel, account.accountId);
      } catch (error) {
        console.warn(`[channel-health] ${channel}/${account.accountId} check failed:`, error);
        await handleFailure(channel, account.accountId);
      }
    }
  }

  async function runCycle(): Promise<void> {
    if (stopped || running) {
      return;
    }
    running = true;
    try {
      await checkChannel('whatsapp');
      await checkChannel('imessage');
    } finally {
      running = false;
    }
  }

  const timer = setInterval(() => {
    void runCycle();
  }, DEFAULT_INTERVAL_MS);
  timer.unref();
  void runCycle();

  const handle: ChannelMonitorHandle = {
    stop: () => {
      stopped = true;
      clearInterval(timer);
      if (globalThis.__channelHealthMonitorHandle === handle) {
        globalThis.__channelHealthMonitorHandle = undefined;
      }
    },
  };

  globalThis.__channelHealthMonitorHandle = handle;
  return handle;
}
