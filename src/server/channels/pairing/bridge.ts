export async function pairBridgeChannel(channel: 'whatsapp' | 'imessage') {
  const envName = channel === 'whatsapp' ? 'WHATSAPP_BRIDGE_URL' : 'IMESSAGE_BRIDGE_URL';
  const bridgeUrl = process.env[envName];
  if (!bridgeUrl) {
    throw new Error(`${envName} is not configured.`);
  }

  const healthUrl = `${bridgeUrl.replace(/\/$/, '')}/health`;
  const response = await fetch(healthUrl);
  if (!response.ok) {
    throw new Error(`${channel} bridge health check failed with ${response.status}.`);
  }
  const data = (await response.json().catch(() => ({}))) as { peerName?: string };
  return {
    peerName: data.peerName || `${channel}-bridge`,
    details: data,
  };
}
