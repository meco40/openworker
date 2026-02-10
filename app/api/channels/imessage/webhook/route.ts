import { NextResponse } from 'next/server';
import { getMessageService } from '../../../../../src/server/channels/messages/runtime';
import { verifySharedSecret } from '../../../../../src/server/channels/webhookAuth';
import { ChannelType } from '../../../../../types';

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

    if (!payload.text?.trim() || !payload.chatGuid) {
      return NextResponse.json({ ok: true });
    }

    const service = getMessageService();
    await service.handleInbound(
      ChannelType.IMESSAGE,
      payload.chatGuid,
      payload.text,
      payload.senderName || 'iMessage User',
      payload.messageId,
    );

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('iMessage webhook error:', error);
    return NextResponse.json({ ok: true });
  }
}
