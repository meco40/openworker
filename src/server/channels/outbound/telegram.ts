/**
 * Telegram message character limit.
 * The API rejects messages longer than 4096 UTF-8 characters.
 */
const TELEGRAM_MAX_LENGTH = 4096;

/**
 * Split a long text into chunks that fit within Telegram's character limit.
 * Tries to break at newlines first, then at spaces, and only hard-cuts as
 * a last resort so words/sentences stay intact where possible.
 */
export function splitTelegramMessage(text: string, maxLen = TELEGRAM_MAX_LENGTH): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    let splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt <= 0) splitAt = remaining.lastIndexOf(' ', maxLen);
    if (splitAt <= 0) splitAt = maxLen;

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, '');
  }

  return chunks;
}

/**
 * Delivers a message to a Telegram chat using the Bot API.
 * Automatically splits messages that exceed Telegram's 4096-char limit.
 */
export async function deliverTelegram(chatId: string, text: string): Promise<void> {
  const { getCredentialStore } = await import('../credentials');
  const token =
    getCredentialStore().getCredential('telegram', 'bot_token') || process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error('Telegram bot token not configured (neither in credential store nor env).');
    return;
  }

  const chunks = splitTelegramMessage(text);

  for (const chunk of chunks) {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: chunk,
      }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(`Telegram delivery failed: ${JSON.stringify(error)}`);
    }
  }
}
