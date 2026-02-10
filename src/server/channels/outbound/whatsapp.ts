/**
 * Delivers a message to WhatsApp via the configured bridge.
 */
export async function deliverWhatsApp(chatId: string, text: string): Promise<void> {
  const bridgeUrl = process.env.WHATSAPP_BRIDGE_URL;
  if (!bridgeUrl) {
    console.error('WHATSAPP_BRIDGE_URL not configured.');
    return;
  }

  const url = `${bridgeUrl.replace(/\/$/, '')}/send`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to: chatId, message: text }),
  });

  if (!response.ok) {
    throw new Error(`WhatsApp delivery failed with status ${response.status}`);
  }
}
