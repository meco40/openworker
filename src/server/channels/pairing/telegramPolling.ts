import { getCredentialStore } from '@/server/channels/credentials';
import { processTelegramInboundUpdate } from '@/server/channels/pairing/telegramInbound';
import { serializeTelegramAllowedUpdates } from '@/server/channels/telegram/allowedUpdates';

const CHANNEL = 'telegram';
const POLL_INTERVAL_MS = 2_000;
const POLLING_LEASE_TTL_MS = 30_000;
const POLLING_CONFLICT_COOLDOWN_MS = 30_000;
const POLLING_OWNER_KEY = 'polling_owner';
const POLLING_LEASE_UNTIL_KEY = 'polling_lease_until';

interface TelegramUpdateMessage {
  message_id: number;
  from?: { id: number; first_name?: string; username?: string };
  chat: { id: number; type: string; is_forum?: boolean };
  text?: string;
  caption?: string;
  message_thread_id?: number;
  migrate_to_chat_id?: number;
  migrate_from_chat_id?: number;
  photo?: Array<{ file_id: string; width?: number; height?: number; file_size?: number }>;
  document?: {
    file_id: string;
    file_name?: string;
    mime_type?: string;
    file_size?: number;
  };
  audio?: {
    file_id: string;
    file_name?: string;
    mime_type?: string;
    file_size?: number;
    duration?: number;
    title?: string;
    performer?: string;
  };
  voice?: {
    file_id: string;
    mime_type?: string;
    file_size?: number;
    duration?: number;
  };
  video?: {
    file_id: string;
    file_name?: string;
    mime_type?: string;
    file_size?: number;
    duration?: number;
  };
  animation?: {
    file_id: string;
    file_name?: string;
    mime_type?: string;
    file_size?: number;
    duration?: number;
  };
  sticker?: {
    file_id: string;
    file_unique_id?: string;
    emoji?: string;
    set_name?: string;
    is_animated?: boolean;
    is_video?: boolean;
  };
}

interface TelegramUpdateCallbackQuery {
  id: string;
  data?: string;
  message?: {
    message_id?: number;
    message_thread_id?: number;
    chat?: { id?: number; type?: string; is_forum?: boolean };
  };
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramUpdateMessage;
  callback_query?: TelegramUpdateCallbackQuery;
}

interface TelegramGetUpdatesResponse {
  ok: boolean;
  result?: TelegramUpdate[];
}

declare global {
  var __telegramPollingTimer: ReturnType<typeof setTimeout> | undefined;
  var __telegramPollingActive: boolean | undefined;
  var __telegramPollingInstanceId: string | undefined;
  var __telegramPollingConflictUntilMs: number | undefined;
}

export async function startTelegramPolling(): Promise<void> {
  if (globalThis.__telegramPollingActive) {
    console.log('[Telegram Polling] Already active, skipping start.');
    return;
  }
  const conflictUntilMs = globalThis.__telegramPollingConflictUntilMs || 0;
  if (Date.now() < conflictUntilMs) {
    return;
  }

  const store = getCredentialStore();
  const token = store.getCredential(CHANNEL, 'bot_token') || process.env.TELEGRAM_BOT_TOKEN;
  const transport = store.getCredential(CHANNEL, 'update_transport');

  if (!token) {
    console.warn('[Telegram Polling] No bot token configured, cannot start polling.');
    return;
  }

  if (transport !== 'polling') {
    console.log('[Telegram Polling] Transport is not polling (transport=%s), skipping.', transport);
    return;
  }
  const ownerId = getPollingOwnerId();
  const hasLease = store.claimLease(
    CHANNEL,
    POLLING_OWNER_KEY,
    POLLING_LEASE_UNTIL_KEY,
    ownerId,
    POLLING_LEASE_TTL_MS,
  );
  if (!hasLease) {
    console.log('[Telegram Polling] Another runtime owns polling lease; skipping start.');
    return;
  }

  try {
    const deleteResponse = await fetch(`https://api.telegram.org/bot${token}/deleteWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ drop_pending_updates: false }),
    });
    if (deleteResponse.ok) {
      console.log('[Telegram Polling] Webhook cleared before starting polling.');
    }
  } catch (err) {
    console.warn('[Telegram Polling] deleteWebhook failed (continuing anyway):', err);
  }

  globalThis.__telegramPollingActive = true;
  console.log('[Telegram Polling] Started.');
  schedulePoll();
}

export function stopTelegramPolling(): void {
  globalThis.__telegramPollingActive = false;
  if (globalThis.__telegramPollingTimer) {
    clearTimeout(globalThis.__telegramPollingTimer);
    globalThis.__telegramPollingTimer = undefined;
  }
  releasePollingLease();
  console.log('[Telegram Polling] Stopped.');
}

export function isTelegramPollingActive(): boolean {
  return !!globalThis.__telegramPollingActive;
}

function schedulePoll(): void {
  if (!globalThis.__telegramPollingActive) return;

  globalThis.__telegramPollingTimer = setTimeout(async () => {
    await pollOnce();
    schedulePoll();
  }, POLL_INTERVAL_MS);
}

async function pollOnce(): Promise<void> {
  const store = getCredentialStore();
  const ownerId = getPollingOwnerId();
  const leaseOk = store.renewLease(
    CHANNEL,
    POLLING_OWNER_KEY,
    POLLING_LEASE_UNTIL_KEY,
    ownerId,
    POLLING_LEASE_TTL_MS,
  );
  if (!leaseOk) {
    console.log('[Telegram Polling] Lease lost; stopping local poller.');
    stopTelegramPolling();
    return;
  }

  const token = store.getCredential(CHANNEL, 'bot_token') || process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    stopTelegramPolling();
    return;
  }

  const offsetRaw = store.getCredential(CHANNEL, 'polling_offset') || '0';
  const offset = Number.parseInt(offsetRaw, 10) || 0;

  try {
    const allowedUpdates = encodeURIComponent(serializeTelegramAllowedUpdates());
    const url = `https://api.telegram.org/bot${token}/getUpdates?offset=${offset}&timeout=1&allowed_updates=${allowedUpdates}`;
    const response = await fetch(url);

    if (!response.ok) {
      console.error('[Telegram Polling] getUpdates HTTP error:', response.status);

      if (response.status === 401 || response.status === 404) {
        console.warn(
          '[Telegram Polling] Bot token appears invalid (HTTP %d). Stopping polling.',
          response.status,
        );
        stopTelegramPolling();
      }

      if (response.status === 409) {
        console.warn(
          '[Telegram Polling] Conflict (409) - another getUpdates is active. Backing off.',
        );
        globalThis.__telegramPollingConflictUntilMs = Date.now() + POLLING_CONFLICT_COOLDOWN_MS;
        stopTelegramPolling();
      }
      return;
    }

    const data = (await response.json()) as TelegramGetUpdatesResponse;
    if (!data.ok || !data.result || data.result.length === 0) {
      return;
    }

    let maxUpdateId = offset;
    for (const update of data.result) {
      if (update.update_id >= maxUpdateId) {
        maxUpdateId = update.update_id + 1;
      }

      if (update.message || update.callback_query) {
        try {
          await processTelegramInboundUpdate(update);
        } catch (err) {
          console.error('[Telegram Polling] Error processing update:', err);
        }
      }
    }

    store.setCredential(CHANNEL, 'polling_offset', String(maxUpdateId));
  } catch (err) {
    console.error('[Telegram Polling] Fetch error:', err);
  }
}

function getPollingOwnerId(): string {
  if (!globalThis.__telegramPollingInstanceId) {
    globalThis.__telegramPollingInstanceId = `telegram-poller:${process.pid}:${Math.random()
      .toString(36)
      .slice(2, 10)}`;
  }
  return globalThis.__telegramPollingInstanceId;
}

function releasePollingLease(): void {
  const ownerId = globalThis.__telegramPollingInstanceId;
  if (!ownerId) return;
  getCredentialStore().releaseLease(CHANNEL, POLLING_OWNER_KEY, POLLING_LEASE_UNTIL_KEY, ownerId);
}
