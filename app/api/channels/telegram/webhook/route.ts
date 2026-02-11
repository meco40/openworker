import { NextResponse } from 'next/server';
import { processTelegramInboundMessage } from '../../../../../src/server/channels/pairing/telegramInbound';
import { verifyTelegramWebhook } from '../../../../../src/server/channels/webhookAuth';
import { normalizeTelegramInbound } from '../../../../../src/server/channels/inbound/normalizers';

export const runtime = 'nodejs';

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from?: { id: number; first_name?: string; username?: string };
    chat: { id: number; type: string };
    text?: string;
  };
}

export async function POST(request: Request) {
  try {
    // Verify webhook authenticity (credential store → env fallback)
    const { getCredentialStore } = await import('../../../../../src/server/channels/credentials');
    const secretToken =
      getCredentialStore().getCredential('telegram', 'webhook_secret') ||
      process.env.TELEGRAM_WEBHOOK_SECRET ||
      '';
    if (!verifyTelegramWebhook(request, secretToken)) {
      return NextResponse.json({ ok: false, error: 'Forbidden' }, { status: 403 });
    }

    const update = (await request.json()) as TelegramUpdate;

    const envelope = normalizeTelegramInbound(update);
    if (!envelope) {
      // Non-text update (sticker, photo, etc.) — acknowledge silently
      return NextResponse.json({ ok: true });
    }

    await processTelegramInboundMessage(update.message);

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('Telegram webhook error:', error);
    // Always return 200 to Telegram to prevent retries
    return NextResponse.json({ ok: true });
  }
}
