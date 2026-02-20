export const TELEGRAM_ALLOWED_UPDATES = ['message', 'callback_query'] as const;

export function serializeTelegramAllowedUpdates(): string {
  return JSON.stringify([...TELEGRAM_ALLOWED_UPDATES]);
}
