import { SqliteMessageRepository } from './sqliteMessageRepository';
import { MessageService } from './service';

declare global {
  var __messageRepository: SqliteMessageRepository | undefined;
  var __messageService: MessageService | undefined;
  var __pollingResumeChecked: boolean | undefined;
}

export function getMessageRepository(): SqliteMessageRepository {
  if (!globalThis.__messageRepository) {
    globalThis.__messageRepository = new SqliteMessageRepository();
  }
  return globalThis.__messageRepository;
}

export function getMessageService(): MessageService {
  if (!globalThis.__messageService) {
    globalThis.__messageService = new MessageService(getMessageRepository());
  }

  // Auto-resume Telegram polling after server restart (once, fire-and-forget)
  if (!globalThis.__pollingResumeChecked) {
    globalThis.__pollingResumeChecked = true;
    (async () => {
      try {
        const { getCredentialStore } = await import('../credentials');
        const store = getCredentialStore();
        const transport = store.getCredential('telegram', 'update_transport');
        const status = store.getCredential('telegram', 'pairing_status');
        const token = store.getCredential('telegram', 'bot_token');

        if (
          transport === 'polling' &&
          token &&
          (status === 'connected' || status === 'awaiting_code')
        ) {
          const { startTelegramPolling } = await import('../pairing/telegramPolling');
          startTelegramPolling();
          console.log('[Runtime] Auto-resumed Telegram polling after server restart.');
        }
      } catch (err) {
        console.warn('[Runtime] Could not auto-resume Telegram polling:', err);
      }
    })();
  }

  return globalThis.__messageService;
}
