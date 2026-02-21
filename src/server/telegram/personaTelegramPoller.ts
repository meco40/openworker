import { getPersonaTelegramBotRegistry } from '@/server/telegram/personaTelegramBotRegistry';
import {
  processTelegramInboundUpdate,
  type TelegramInboundUpdate,
} from '@/server/channels/pairing/telegramInbound';
import { serializeTelegramAllowedUpdates } from '@/server/channels/telegram/allowedUpdates';

const POLL_INTERVAL_MS = 2_000;

interface PollerState {
  timer: ReturnType<typeof setTimeout> | null;
  active: boolean;
}

// Module-level map — keyed by botId (survives across calls in same process)
const pollers = new Map<string, PollerState>();

// ─── Public API ───────────────────────────────────────────────

export async function startPersonaBotPolling(botId: string): Promise<void> {
  const existing = pollers.get(botId);
  if (existing?.active) return;

  pollers.set(botId, { timer: null, active: true });
  schedulePersonaBotPoll(botId);
}

export function stopPersonaBotPolling(botId: string): void {
  const state = pollers.get(botId);
  if (!state) return;
  if (state.timer) clearTimeout(state.timer);
  state.active = false;
  pollers.delete(botId);
}

export function isPersonaBotPollingActive(botId: string): boolean {
  return pollers.get(botId)?.active ?? false;
}

export function stopAllPersonaBotPolling(): void {
  for (const botId of [...pollers.keys()]) {
    stopPersonaBotPolling(botId);
  }
}

// ─── Internal ────────────────────────────────────────────────

function schedulePersonaBotPoll(botId: string): void {
  const state = pollers.get(botId);
  if (!state?.active) return;

  const timer = setTimeout(() => {
    void pollPersonaBotOnce(botId).finally(() => {
      if (pollers.get(botId)?.active) {
        schedulePersonaBotPoll(botId);
      }
    });
  }, POLL_INTERVAL_MS);

  if (state) state.timer = timer;
}

async function pollPersonaBotOnce(botId: string): Promise<void> {
  const registry = getPersonaTelegramBotRegistry();
  const bot = registry.getBot(botId);
  if (!bot || !bot.active) {
    stopPersonaBotPolling(botId);
    return;
  }

  try {
    let allowedUpdates: string[];
    try {
      allowedUpdates = JSON.parse(serializeTelegramAllowedUpdates()) as string[];
    } catch {
      allowedUpdates = ['message', 'callback_query'];
    }

    const url = new URL(`https://api.telegram.org/bot${bot.token}/getUpdates`);
    url.searchParams.set('timeout', '1');
    url.searchParams.set('limit', '20');
    url.searchParams.set('allowed_updates', JSON.stringify(allowedUpdates));
    if (bot.pollingOffset > 0) {
      url.searchParams.set('offset', String(bot.pollingOffset));
    }

    const response = await fetch(url.toString());
    if (!response.ok) {
      console.error(`[PersonaBotPoller:${botId}] getUpdates HTTP ${response.status}`);
      return;
    }

    const data = (await response.json()) as {
      ok: boolean;
      result?: Array<TelegramInboundUpdate & { update_id: number }>;
    };
    if (!data.ok || !data.result || data.result.length === 0) return;

    let maxUpdateId = bot.pollingOffset;

    for (const update of data.result) {
      if (update.update_id > maxUpdateId) maxUpdateId = update.update_id;
      await processTelegramInboundUpdate(update, {
        botId,
        personaId: bot.personaId,
        token: bot.token,
      });
    }

    const newOffset = maxUpdateId + 1;
    if (newOffset > bot.pollingOffset) {
      registry.setPollingOffset(botId, newOffset);
    }
  } catch (err) {
    console.error(`[PersonaBotPoller:${botId}] Poll error:`, err);
  }
}
