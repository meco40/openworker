import crypto from 'node:crypto';
import { beginTelegramCodePairing } from '@/server/channels/pairing/telegramCodePairing';
import {
  startTelegramPolling,
  stopTelegramPolling,
} from '@/server/channels/pairing/telegramPolling';
import { serializeTelegramAllowedUpdates } from '@/server/channels/telegram/allowedUpdates';
import { syncTelegramNativeCommands } from '@/server/channels/telegram/nativeCommands';

export async function pairTelegram(token: string) {
  if (!token) throw new Error('Telegram token is required.');

  const meResponse = await fetch(`https://api.telegram.org/bot${token}/getMe`);
  const meData = (await meResponse.json()) as {
    ok?: boolean;
    result?: { username?: string; id?: number };
  };
  if (!meResponse.ok || !meData.ok) {
    throw new Error(`Telegram auth failed: ${JSON.stringify(meData)}`);
  }

  const webhookSecret = crypto.randomBytes(32).toString('hex');

  let transport: 'webhook' | 'polling' = 'polling';
  const appUrl = process.env.APP_URL || process.env.NEXTAUTH_URL || process.env.VERCEL_URL;
  if (appUrl) {
    const webhookUrl = `${appUrl.replace(/\/$/, '')}/api/channels/telegram/webhook`;
    const whResponse = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: webhookUrl,
        secret_token: webhookSecret,
        allowed_updates: JSON.parse(serializeTelegramAllowedUpdates()),
      }),
    });
    const whData = (await whResponse.json()) as { ok?: boolean; description?: string };
    if (whData.ok) {
      transport = 'webhook';
    } else {
      console.warn(`Telegram webhook setup warning: ${whData.description}`);
    }
  } else {
    console.warn('APP_URL not set - Telegram webhook not registered. Set APP_URL for production.');
  }

  if (transport === 'polling') {
    try {
      await fetch(`https://api.telegram.org/bot${token}/deleteWebhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ drop_pending_updates: true }),
      });
    } catch (error) {
      console.warn('Telegram deleteWebhook warning while switching to polling mode:', error);
    }
  }

  const { getCredentialStore } = await import('@/server/channels/credentials');
  const store = getCredentialStore();

  stopTelegramPolling();

  store.setCredential('telegram', 'bot_token', token);
  store.setCredential('telegram', 'webhook_secret', webhookSecret);
  store.setCredential('telegram', 'update_transport', transport);
  store.setCredential('telegram', 'polling_offset', '0');
  process.env.TELEGRAM_BOT_TOKEN = token;
  process.env.TELEGRAM_WEBHOOK_SECRET = webhookSecret;

  beginTelegramCodePairing();

  if (transport === 'polling') {
    await startTelegramPolling();
  }

  void syncTelegramNativeCommands(token);

  return {
    status: 'awaiting_code' as const,
    transport,
    peerName: meData.result?.username || `telegram:${meData.result?.id || 'unknown'}`,
    details: meData.result,
  };
}
