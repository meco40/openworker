/**
 * Delivers a message to iMessage via a bridge (e.g. BlueBubbles/AirMessage).
 */
export async function deliveriMessage(chatId: string, text: string): Promise<void> {
  const bridgeUrl = process.env.IMESSAGE_BRIDGE_URL;
  if (!bridgeUrl) {
    console.error('IMESSAGE_BRIDGE_URL not configured.');
    return;
  }

  const url = `${bridgeUrl.replace(/\/$/, '')}/send`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatGuid: chatId, message: text }),
  });

  if (!response.ok) {
    throw new Error(`iMessage delivery failed with status ${response.status}`);
  }
}
