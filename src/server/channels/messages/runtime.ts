import { SqliteMessageRepository } from '@/server/channels/messages/sqliteMessageRepository';
import { MessageService } from '@/server/channels/messages/service';

declare global {
  var __messageRepository: SqliteMessageRepository | undefined;
  var __messageService: MessageService | undefined;
  var __pollingResumeChecked: boolean | undefined;
  var __channelHealthMonitorChecked: boolean | undefined;
  var __eventSubscribersChecked: boolean | undefined;
  var __messageRuntimeBootstrapPromise: Promise<void> | undefined;
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

  return globalThis.__messageService;
}

async function bootstrapMessageRuntimeInternal(): Promise<void> {
  // Auto-resume Telegram polling after server restart (once).
  if (!globalThis.__pollingResumeChecked) {
    globalThis.__pollingResumeChecked = true;
    try {
      const { getCredentialStore } = await import('@/server/channels/credentials');
      const store = getCredentialStore();
      const transport = store.getCredential('telegram', 'update_transport');
      const status = store.getCredential('telegram', 'pairing_status');
      const token = store.getCredential('telegram', 'bot_token');

      if (
        transport === 'polling' &&
        token &&
        (status === 'connected' || status === 'awaiting_code')
      ) {
        const { startTelegramPolling } = await import('@/server/channels/pairing/telegramPolling');
        await startTelegramPolling();
        console.log('[Runtime] Auto-resumed Telegram polling after server restart.');
      }
    } catch (err) {
      console.warn('[Runtime] Could not auto-resume Telegram polling:', err);
    }
  }

  if (!globalThis.__channelHealthMonitorChecked) {
    globalThis.__channelHealthMonitorChecked = true;
    try {
      const { startChannelHealthMonitor } = await import('@/server/channels/healthMonitor');
      startChannelHealthMonitor();
    } catch (error) {
      console.warn('[Runtime] Could not start channel health monitor:', error);
    }
  }

  if (!globalThis.__eventSubscribersChecked) {
    globalThis.__eventSubscribersChecked = true;
    try {
      const { registerProactiveEventSubscribers } = await import('@/server/proactive/subscribers');
      registerProactiveEventSubscribers();
    } catch (error) {
      console.warn('[Runtime] Could not register proactive event subscribers:', error);
    }
  }
}

export async function bootstrapMessageRuntime(): Promise<void> {
  if (!globalThis.__messageRuntimeBootstrapPromise) {
    globalThis.__messageRuntimeBootstrapPromise = bootstrapMessageRuntimeInternal();
  }
  await globalThis.__messageRuntimeBootstrapPromise;
}
