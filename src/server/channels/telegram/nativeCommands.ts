export interface TelegramMenuCommand {
  command: string;
  description: string;
}

export const TELEGRAM_NATIVE_COMMANDS: TelegramMenuCommand[] = [
  { command: 'new', description: 'Start a new conversation' },
  { command: 'reset', description: 'Reset the current conversation' },
  { command: 'persona', description: 'List or switch persona' },
  { command: 'cron', description: 'Manage automation rules' },
  { command: 'model', description: 'Inspect or switch chat model' },
];

async function callTelegramApi(
  token: string,
  method: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(`${method} failed: ${JSON.stringify(body)}`);
  }
}

export async function syncTelegramNativeCommands(
  token: string,
  commands: TelegramMenuCommand[] = TELEGRAM_NATIVE_COMMANDS,
): Promise<void> {
  if (!token.trim()) {
    return;
  }

  try {
    await callTelegramApi(token, 'deleteMyCommands', {});
  } catch (error) {
    console.warn('[Telegram] deleteMyCommands failed:', error);
  }

  if (commands.length === 0) {
    return;
  }

  try {
    await callTelegramApi(token, 'setMyCommands', { commands });
  } catch (error) {
    console.warn('[Telegram] setMyCommands failed:', error);
  }
}
