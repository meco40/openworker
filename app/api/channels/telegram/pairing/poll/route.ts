import { NextResponse } from 'next/server';
import { getCredentialStore } from '../../../../../../src/server/channels/credentials';
import { processTelegramInboundMessage } from '../../../../../../src/server/channels/pairing/telegramInbound';

export const runtime = 'nodejs';

interface TelegramGetUpdatesResponse {
  ok?: boolean;
  description?: string;
  result?: Array<{
    update_id: number;
    message?: {
      message_id: number;
      from?: { id: number; first_name?: string; username?: string };
      chat: { id: number; type: string };
      text?: string;
    };
  }>;
}

function parseOffset(raw: string | null): number {
  if (!raw) return 0;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

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
      return NextResponse.json({ ok: false, error: 'Telegram bot token not configured.' }, { status: 500 });
    }

    const offset = parseOffset(store.getCredential('telegram', 'polling_offset'));
    const updatesUrl = new URL(`https://api.telegram.org/bot${token}/getUpdates`);
    updatesUrl.searchParams.set('timeout', '0');
    updatesUrl.searchParams.set('limit', '20');
    if (offset > 0) {
      updatesUrl.searchParams.set('offset', String(offset));
    }

    const updatesResponse = await fetch(updatesUrl.toString());
    const updatesData = (await updatesResponse.json()) as TelegramGetUpdatesResponse;
    if (!updatesResponse.ok || !updatesData.ok) {
      const reason = updatesData.description || `HTTP ${updatesResponse.status}`;
      return NextResponse.json({ ok: false, error: `Telegram getUpdates failed: ${reason}` }, { status: 502 });
    }

    const updates = updatesData.result || [];
    let processed = 0;
    let codeIssued = false;
    let nextOffset = offset;

    for (const update of updates) {
      nextOffset = Math.max(nextOffset, update.update_id + 1);
      if (!update.message?.text) {
        continue;
      }
      processed += 1;
      const result = await processTelegramInboundMessage(update.message);
      codeIssued = codeIssued || result.codeIssued;
    }

    if (nextOffset !== offset) {
      store.setCredential('telegram', 'polling_offset', String(nextOffset));
    }

    return NextResponse.json({
      ok: true,
      mode: 'polling',
      processed,
      codeIssued,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown Telegram polling error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
