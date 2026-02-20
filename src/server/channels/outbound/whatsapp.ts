import { parseScopedBridgeExternalChatId } from '@/server/channels/pairing/bridgeAccounts';

/**
 * Delivers a message to WhatsApp via the configured bridge.
 */
export async function deliverWhatsApp(
  scopedChatId: string,
  text: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  const bridgeUrl = process.env.WHATSAPP_BRIDGE_URL;
  if (!bridgeUrl) {
    console.error('WHATSAPP_BRIDGE_URL not configured.');
    return;
  }

  const scoped = parseScopedBridgeExternalChatId(scopedChatId);
  const accountIdFromMetadata =
    typeof metadata?.accountId === 'string' ? String(metadata.accountId).trim() : '';
  const accountId = accountIdFromMetadata || scoped.accountId;
  const chatId = scoped.externalChatId;
  const url = `${bridgeUrl.replace(/\/$/, '')}/send`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-openclaw-account-id': accountId,
    },
    body: JSON.stringify({ to: chatId, message: text, accountId, metadata }),
  });

  if (!response.ok) {
    throw new Error(`WhatsApp delivery failed with status ${response.status}`);
  }
}
