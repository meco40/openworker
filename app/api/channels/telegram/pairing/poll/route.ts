import { NextResponse } from 'next/server';
import { getCredentialStore } from '@/server/channels/credentials';
import {
  isTelegramPollingActive,
  startTelegramPolling,
} from '@/server/channels/pairing/telegramPolling';

export const runtime = 'nodejs';

export async function POST(_request: Request) {
  void _request;
  try {
    const store = getCredentialStore();
    const transport = store.getCredential('telegram', 'update_transport') || 'webhook';
    if (transport !== 'polling') {
      return NextResponse.json({ ok: true, mode: transport, processed: 0, codeIssued: false });
    }

    const token = store.getCredential('telegram', 'bot_token') || process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
      return NextResponse.json(
        { ok: false, error: 'Telegram bot token not configured.' },
        { status: 500 },
      );
    }

    // If background polling is already running, do NOT call getUpdates from
    // here — two concurrent getUpdates on the same token causes Telegram 409.
    // Instead, ensure the poller is running and return current status.
    if (isTelegramPollingActive()) {
      return NextResponse.json({
        ok: true,
        mode: 'polling',
        processed: 0,
        codeIssued: false,
        delegated: true,
      });
    }

    // No background poller — start it so future requests are handled there.
    // Do NOT call getUpdates here as well; the background poller will pick up
    // messages within its 2-second cycle. Calling getUpdates from both this
    // route and the background poller causes Telegram 409 conflicts and
    // duplicate message processing.
    await startTelegramPolling();

    return NextResponse.json({
      ok: true,
      mode: 'polling',
      processed: 0,
      codeIssued: false,
      delegated: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown Telegram polling error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
