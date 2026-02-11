import { getCredentialStore } from '../credentials';
import { processTelegramInboundMessage } from './telegramInbound';

const CHANNEL = 'telegram';
const POLL_INTERVAL_MS = 2_000; // 2 seconds

interface TelegramUpdateMessage {
  message_id: number;
  from?: { id: number; first_name?: string; username?: string };
  chat: { id: number; type: string };
  text?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramUpdateMessage;
}

interface TelegramGetUpdatesResponse {
  ok: boolean;
  result?: TelegramUpdate[];
}

// ─── Polling State ───────────────────────────────────────────

declare global {
  var __telegramPollingTimer: ReturnType<typeof setTimeout> | undefined;
  var __telegramPollingActive: boolean | undefined;
}

// ─── Start / Stop ────────────────────────────────────────────

export async function startTelegramPolling(): Promise<void> {
  if (globalThis.__telegramPollingActive) {
    console.log('[Telegram Polling] Already active, skipping start.');
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

  // Telegram returns 409 on getUpdates when a webhook is still registered.
  // Always delete the webhook before starting the polling loop.
  try {
    const deleteResponse = await fetch(
      `https://api.telegram.org/bot${token}/deleteWebhook`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ drop_pending_updates: false }),
      },
    );
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
  console.log('[Telegram Polling] Stopped.');
}

export function isTelegramPollingActive(): boolean {
  return !!globalThis.__telegramPollingActive;
}

// ─── Internal ────────────────────────────────────────────────

function schedulePoll(): void {
  if (!globalThis.__telegramPollingActive) return;

  globalThis.__telegramPollingTimer = setTimeout(async () => {
    await pollOnce();
    schedulePoll();
  }, POLL_INTERVAL_MS);
}

async function pollOnce(): Promise<void> {
  const store = getCredentialStore();
  const token = store.getCredential(CHANNEL, 'bot_token') || process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    stopTelegramPolling();
    return;
  }

  const offsetRaw = store.getCredential(CHANNEL, 'polling_offset') || '0';
  const offset = parseInt(offsetRaw, 10) || 0;

  try {
    const url = `https://api.telegram.org/bot${token}/getUpdates?offset=${offset}&timeout=1&allowed_updates=["message"]`;
    const response = await fetch(url);

    if (!response.ok) {
      console.error('[Telegram Polling] getUpdates HTTP error:', response.status);
      // 401/404 means the bot token is invalid — stop polling to avoid spam
      if (response.status === 401 || response.status === 404) {
        console.warn('[Telegram Polling] Bot token appears invalid (HTTP %d). Stopping polling.', response.status);
        stopTelegramPolling();
      }
      // 409 means another getUpdates call is in-flight (e.g. duplicate polling instance)
      // Back off and let the other caller finish.
      if (response.status === 409) {
        console.warn('[Telegram Polling] Conflict (409) — another getUpdates is active. Backing off.');
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

      if (update.message?.text) {
        try {
          await processTelegramInboundMessage(update.message);
        } catch (err) {
          console.error('[Telegram Polling] Error processing message:', err);
        }
      }
    }

    // Persist new offset so we don't re-process old updates
    store.setCredential(CHANNEL, 'polling_offset', String(maxUpdateId));
  } catch (err) {
    console.error('[Telegram Polling] Fetch error:', err);
  }
}
