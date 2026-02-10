/**
 * Delivers a message to a Telegram chat using the Bot API.
 */
export async function deliverTelegram(chatId: string, text: string): Promise<void> {
  const { getCredentialStore } = await import('../credentials');
  const token =
    getCredentialStore().getCredential('telegram', 'bot_token') || process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error('Telegram bot token not configured (neither in credential store nor env).');
    return;
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: text,
    }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(`Telegram delivery failed: ${JSON.stringify(error)}`);
  }
}
