import crypto from 'node:crypto';
import { beginTelegramCodePairing } from './telegramCodePairing';
import { startTelegramPolling, stopTelegramPolling } from './telegramPolling';

export async function pairTelegram(token: string) {
  if (!token) throw new Error('Telegram token is required.');

  // 1. Validate token with getMe
  const meResponse = await fetch(`https://api.telegram.org/bot${token}/getMe`);
  const meData = (await meResponse.json()) as {
    ok?: boolean;
    result?: { username?: string; id?: number };
  };
  if (!meResponse.ok || !meData.ok) {
    throw new Error(`Telegram auth failed: ${JSON.stringify(meData)}`);
  }

  // 2. Generate a webhook secret for verification
  const webhookSecret = crypto.randomBytes(32).toString('hex');

  // 3. Register webhook so Telegram sends updates to our endpoint (if URL available)
  let transport: 'webhook' | 'polling' = 'polling';
  const appUrl = process.env.APP_URL || process.env.NEXTAUTH_URL || process.env.VERCEL_URL;
  if (appUrl) {
    const webhookUrl = `${appUrl.replace(/\/$/, '')}/api/channels/telegram/webhook`;
    const whResponse = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: webhookUrl, secret_token: webhookSecret }),
    });
    const whData = (await whResponse.json()) as { ok?: boolean; description?: string };
    if (whData.ok) {
      transport = 'webhook';
    } else {
      console.warn(`Telegram webhook setup warning: ${whData.description}`);
    }
  } else {
    console.warn('APP_URL not set — Telegram webhook not registered. Set APP_URL for production.');
  }

  // If webhook is unavailable, ensure polling mode is usable.
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

  // 4. Persist token and webhook secret to credential store + env fallback
  const { getCredentialStore } = await import('../credentials');
  const store = getCredentialStore();

  // Stop any previous polling before overwriting credentials
  stopTelegramPolling();

  store.setCredential('telegram', 'bot_token', token);
  store.setCredential('telegram', 'webhook_secret', webhookSecret);
  store.setCredential('telegram', 'update_transport', transport);
  store.setCredential('telegram', 'polling_offset', '0');
  process.env.TELEGRAM_BOT_TOKEN = token;
  process.env.TELEGRAM_WEBHOOK_SECRET = webhookSecret;

  beginTelegramCodePairing();

  // Start polling loop automatically when webhook is not available
  if (transport === 'polling') {
    await startTelegramPolling();
  }

  return {
    status: 'awaiting_code' as const,
    transport,
    peerName: meData.result?.username || `telegram:${meData.result?.id || 'unknown'}`,
    details: meData.result,
  };
}
