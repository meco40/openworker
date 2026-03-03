import crypto from 'node:crypto';
import { createId } from '@/shared/lib/ids';
import { getPersonaTelegramBotRegistry } from '@/server/telegram/personaTelegramBotRegistry';
import {
  startPersonaBotPolling,
  stopPersonaBotPolling,
} from '@/server/telegram/personaTelegramPoller';
import { serializeTelegramAllowedUpdates } from '@/server/channels/telegram/allowedUpdates';

const IS_TEST_RUNTIME = process.env.NODE_ENV === 'test';

// ─── Types ───────────────────────────────────────────────────

export interface PairPersonaTelegramResult {
  botId: string;
  peerName: string;
  transport: 'webhook' | 'polling';
}

// ─── Pairing ─────────────────────────────────────────────────

export async function pairPersonaTelegram(
  personaId: string,
  token: string,
): Promise<PairPersonaTelegramResult> {
  if (!token?.trim()) throw new Error('Token is required.');
  const registry = getPersonaTelegramBotRegistry();
  const tokenOwner = registry.listAllBots().find((bot) => bot.token === token);
  if (tokenOwner) {
    throw new Error(
      `Telegram token is already paired with persona "${tokenOwner.personaId}". Unpair it first.`,
    );
  }

  // 1. Validate token with getMe
  const meResponse = await fetch(`https://api.telegram.org/bot${token}/getMe`);
  const meData = (await meResponse.json()) as {
    ok?: boolean;
    result?: { username?: string; id?: number };
  };
  if (!meResponse.ok || !meData.ok) {
    throw new Error(`Telegram auth failed: ${JSON.stringify(meData)}`);
  }

  const peerName = meData.result?.username ?? `bot-${meData.result?.id ?? 'unknown'}`;
  const botId = createId('tgbot');
  const webhookSecret = crypto.randomBytes(32).toString('hex');

  let transport: 'webhook' | 'polling' = 'polling';

  // 2. Register webhook if APP_URL is available, else use polling
  const appUrl = process.env.APP_URL || process.env.NEXTAUTH_URL || process.env.VERCEL_URL;
  if (appUrl) {
    const webhookUrl = `${appUrl.replace(/\/$/, '')}/api/channels/telegram/bots/${botId}/webhook`;
    let allowedUpdates: string[];
    try {
      allowedUpdates = JSON.parse(serializeTelegramAllowedUpdates()) as string[];
    } catch {
      allowedUpdates = ['message', 'callback_query'];
    }

    const whResponse = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: webhookUrl,
        secret_token: webhookSecret,
        allowed_updates: allowedUpdates,
      }),
    });
    const whData = (await whResponse.json()) as { ok?: boolean; description?: string };
    if (whData.ok) {
      transport = 'webhook';
    } else if (!IS_TEST_RUNTIME) {
      console.warn(
        `[PersonaTelegramPairing] Webhook setup warning for persona ${personaId}: ${whData.description}`,
      );
    }
  } else if (!IS_TEST_RUNTIME) {
    console.warn(
      '[PersonaTelegramPairing] APP_URL not set — using polling mode for persona',
      personaId,
    );
  }

  // 3. For polling: clear any old webhook
  if (transport === 'polling') {
    try {
      await fetch(`https://api.telegram.org/bot${token}/deleteWebhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ drop_pending_updates: true }),
      });
    } catch {
      // ignore cleanup errors
    }
  }

  // 4. Stop any existing bot for this persona
  const existing = registry.getBotByPersonaId(personaId);
  if (existing) {
    stopPersonaBotPolling(existing.botId);
    // Remove old webhook if it was a different bot token
    if (existing.transport === 'webhook') {
      try {
        await fetch(`https://api.telegram.org/bot${existing.token}/deleteWebhook`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ drop_pending_updates: false }),
        });
      } catch {
        // ignore
      }
    }
  }

  // 5. Register in registry
  registry.upsertBot({
    botId,
    personaId,
    token,
    webhookSecret,
    peerName,
    transport,
  });

  // 6. Start polling if needed
  if (transport === 'polling') {
    await startPersonaBotPolling(botId);
  }

  return { botId, peerName, transport };
}

// ─── Unpairing ───────────────────────────────────────────────

export async function unpairPersonaTelegram(personaId: string): Promise<void> {
  const registry = getPersonaTelegramBotRegistry();
  const bot = registry.getBotByPersonaId(personaId);
  if (!bot) return;

  // Stop polling
  stopPersonaBotPolling(bot.botId);

  // Delete webhook (fire-and-forget, don't block on failure)
  try {
    await fetch(`https://api.telegram.org/bot${bot.token}/deleteWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ drop_pending_updates: false }),
    });
  } catch {
    // ignore
  }

  registry.removeByPersonaId(personaId);
}
