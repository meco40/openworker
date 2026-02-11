import { getCredentialStore } from '../credentials';

export async function pairBridgeChannel(channel: 'whatsapp' | 'imessage') {
  const envName = channel === 'whatsapp' ? 'WHATSAPP_BRIDGE_URL' : 'IMESSAGE_BRIDGE_URL';
  const bridgeUrl = process.env[envName];
  if (!bridgeUrl) {
    throw new Error(`${envName} is not configured.`);
  }

  // 1. Health check
  const healthUrl = `${bridgeUrl.replace(/\/$/, '')}/health`;
  const response = await fetch(healthUrl);
  if (!response.ok) {
    throw new Error(`${channel} bridge health check failed with ${response.status}.`);
  }
  const data = (await response.json().catch(() => ({}))) as { peerName?: string };

  // 2. Register webhook callback so the bridge forwards incoming messages to us
  const appUrl = process.env.APP_URL || process.env.NEXTAUTH_URL || process.env.VERCEL_URL;
  if (appUrl) {
    const webhookUrl = `${appUrl.replace(/\/$/, '')}/api/channels/${channel}/webhook`;
    try {
      await fetch(`${bridgeUrl.replace(/\/$/, '')}/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callbackUrl: webhookUrl }),
      });
    } catch (error) {
      console.warn(`${channel} webhook registration warning:`, error);
    }
  } else {
    console.warn('APP_URL not set — bridge webhook not registered.');
  }

  try {
    const store = getCredentialStore();
    store.setCredential(channel, 'pairing_status', 'connected');
  } catch (error) {
    console.warn(`${channel} pairing status persistence warning:`, error);
  }

  return {
    peerName: data.peerName || `${channel}-bridge`,
    details: data,
  };
}
