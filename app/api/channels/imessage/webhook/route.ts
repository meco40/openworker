import { NextResponse } from 'next/server';
import { getMessageService } from '../../../../../src/server/channels/messages/runtime';
import { verifySharedSecret } from '../../../../../src/server/channels/webhookAuth';
import { ChannelType } from '../../../../../types';
import { normalizeIMessageInbound } from '../../../../../src/server/channels/inbound/normalizers';

export const runtime = 'nodejs';

interface iMessageWebhookPayload {
  chatGuid?: string;
  text?: string;
  senderName?: string;
  messageId?: string;
}

export async function POST(request: Request) {
  try {
    // Verify webhook authenticity
    const secret = process.env.IMESSAGE_WEBHOOK_SECRET || '';
    if (!verifySharedSecret(request, secret)) {
      return NextResponse.json({ ok: false, error: 'Forbidden' }, { status: 403 });
    }

    const payload = (await request.json()) as iMessageWebhookPayload;

    const envelope = normalizeIMessageInbound(payload);
    if (!envelope) {
      return NextResponse.json({ ok: true });
    }

    const service = getMessageService();
    await service.handleInbound(
      ChannelType.IMESSAGE,
      envelope.externalChatId,
      envelope.content,
      envelope.senderName || 'iMessage User',
      envelope.externalMessageId || undefined,
    );

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('iMessage webhook error:', error);
    return NextResponse.json({ ok: true });
  }
}
