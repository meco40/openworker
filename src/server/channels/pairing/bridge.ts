import crypto from 'node:crypto';
import { getCredentialStore } from '@/server/channels/credentials';
import {
  normalizeBridgeAccountId,
  resolveBridgeAccountSecret,
  upsertBridgeAccount,
  type BridgeChannel,
} from '@/server/channels/pairing/bridgeAccounts';

const IS_TEST_RUNTIME = process.env.NODE_ENV === 'test';

function resolveBridgeUrl(channel: BridgeChannel): string {
  const envName = channel === 'whatsapp' ? 'WHATSAPP_BRIDGE_URL' : 'IMESSAGE_BRIDGE_URL';
  const bridgeUrl = process.env[envName];
  if (!bridgeUrl) {
    throw new Error(`${envName} is not configured.`);
  }
  return bridgeUrl.replace(/\/$/, '');
}

export async function probeBridgeHealth(channel: BridgeChannel): Promise<{
  ok: boolean;
  status: number;
  peerName?: string;
  details?: Record<string, unknown>;
}> {
  const bridgeBaseUrl = resolveBridgeUrl(channel);
  const response = await fetch(`${bridgeBaseUrl}/health`);
  if (!response.ok) {
    return { ok: false, status: response.status };
  }

  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return {
    ok: true,
    status: response.status,
    peerName: typeof payload.peerName === 'string' ? payload.peerName : undefined,
    details: payload,
  };
}

export async function registerBridgeWebhook(params: {
  channel: BridgeChannel;
  accountId?: string;
  webhookSecret?: string;
}): Promise<{ ok: boolean; callbackUrl?: string }> {
  const accountId = normalizeBridgeAccountId(params.accountId);
  const bridgeBaseUrl = resolveBridgeUrl(params.channel);
  const appUrl = process.env.APP_URL || process.env.NEXTAUTH_URL || process.env.VERCEL_URL;
  if (!appUrl) {
    if (!IS_TEST_RUNTIME) {
      console.warn('APP_URL not set - bridge webhook not registered.');
    }
    return { ok: false };
  }

  const callbackUrl = `${appUrl.replace(/\/$/, '')}/api/channels/${params.channel}/webhook?accountId=${encodeURIComponent(accountId)}`;
  const webhookSecret =
    params.webhookSecret || resolveBridgeAccountSecret(params.channel, accountId);

  try {
    const response = await fetch(`${bridgeBaseUrl}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        callbackUrl,
        accountId,
        secret: webhookSecret,
        headers: {
          'x-webhook-secret': webhookSecret,
          'x-openclaw-account-id': accountId,
        },
      }),
    });
    if (!response.ok) {
      if (!IS_TEST_RUNTIME) {
        console.warn(
          `${params.channel} webhook registration failed with status ${response.status}.`,
        );
      }
      return { ok: false, callbackUrl };
    }
    return { ok: true, callbackUrl };
  } catch (error) {
    if (!IS_TEST_RUNTIME) {
      console.warn(`${params.channel} webhook registration warning:`, error);
    }
    return { ok: false, callbackUrl };
  }
}

export async function pairBridgeChannel(channel: BridgeChannel, accountIdInput?: string) {
  const accountId = normalizeBridgeAccountId(accountIdInput);
  const health = await probeBridgeHealth(channel);
  if (!health.ok) {
    throw new Error(`${channel} bridge health check failed with ${health.status}.`);
  }

  const webhookSecret = crypto.randomBytes(32).toString('hex');
  await registerBridgeWebhook({ channel, accountId, webhookSecret });

  try {
    const store = getCredentialStore();
    upsertBridgeAccount(
      channel,
      {
        accountId,
        pairingStatus: 'connected',
        webhookSecret,
        peerName: health.peerName || `${channel}-bridge`,
        touchLastSeen: true,
      },
      store,
    );
  } catch (error) {
    if (!IS_TEST_RUNTIME) {
      console.warn(`${channel} pairing status persistence warning:`, error);
    }
  }

  return {
    accountId,
    peerName: health.peerName || `${channel}-bridge`,
    details: health.details || {},
  };
}
