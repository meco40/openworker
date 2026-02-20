import { NextResponse } from 'next/server';
import { confirmTelegramPairingCode } from '@/server/channels/pairing/telegramCodePairing';

export const runtime = 'nodejs';

interface ConfirmRequest {
  code?: string;
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as ConfirmRequest;
    if (!body.code?.trim()) {
      return NextResponse.json({ ok: false, error: 'code is required' }, { status: 400 });
    }

    const confirmed = confirmTelegramPairingCode(body.code);
    if (!confirmed.ok) {
      return NextResponse.json({ ok: false, error: confirmed.error }, { status: 400 });
    }

    return NextResponse.json({
      ok: true,
      status: 'connected',
      chatId: confirmed.chatId,
      connectedAt: new Date().toISOString(),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unknown Telegram pairing confirmation error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
