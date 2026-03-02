import { NextResponse } from 'next/server';
import { confirmTelegramPairingCode } from '@/server/channels/pairing/telegramCodePairing';
import { getMessageRepository } from '@/server/channels/messages/runtime';
import { getCredentialStore } from '@/server/channels/credentials';
import { withResolvedUserContext } from '../../../../_shared/withUserContext';

export const runtime = 'nodejs';

interface ConfirmRequest {
  code?: string;
}

export const POST = withResolvedUserContext(async ({ request, userContext }) => {
  try {
    const body = (await request.json()) as ConfirmRequest;
    if (!body.code?.trim()) {
      return NextResponse.json({ ok: false, error: 'code is required' }, { status: 400 });
    }

    const confirmed = confirmTelegramPairingCode(body.code);
    if (!confirmed.ok) {
      return NextResponse.json({ ok: false, error: confirmed.error }, { status: 400 });
    }

    const connectedAt = new Date().toISOString();

    // Persist binding so /api/channels/state reflects 'connected' on refresh
    if (userContext) {
      const store = getCredentialStore();
      const transport = store.getCredential('telegram', 'update_transport') || 'webhook';
      const repo = getMessageRepository();
      repo.upsertChannelBinding?.({
        userId: userContext.userId,
        channel: 'telegram',
        status: 'connected',
        peerName: confirmed.chatId ? `telegram:${confirmed.chatId}` : undefined,
        transport,
      });
    }

    return NextResponse.json({
      ok: true,
      status: 'connected',
      chatId: confirmed.chatId,
      connectedAt,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unknown Telegram pairing confirmation error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
});
