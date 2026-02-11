import { NextResponse } from 'next/server';
import { getMessageService } from '../../../../../src/server/channels/messages/runtime';
import { verifySharedSecret } from '../../../../../src/server/channels/webhookAuth';
import { ChannelType } from '../../../../../types';
import { normalizeWhatsAppInbound } from '../../../../../src/server/channels/inbound/normalizers';

export const runtime = 'nodejs';

interface WhatsAppWebhookPayload {
  from?: string;
  chatId?: string;
  body?: string;
  messageId?: string;
  senderName?: string;
}

export async function POST(request: Request) {
  try {
    // Verify webhook authenticity
    const secret = process.env.WHATSAPP_WEBHOOK_SECRET || '';
    if (!verifySharedSecret(request, secret)) {
      return NextResponse.json({ ok: false, error: 'Forbidden' }, { status: 403 });
    }

    const payload = (await request.json()) as WhatsAppWebhookPayload;

    const envelope = normalizeWhatsAppInbound(payload);
    if (!envelope) {
      return NextResponse.json({ ok: true });
    }

    const service = getMessageService();
    await service.handleInbound(
      ChannelType.WHATSAPP,
      envelope.externalChatId,
      envelope.content,
      envelope.senderName || 'WhatsApp User',
      envelope.externalMessageId || undefined,
    );

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('WhatsApp webhook error:', error);
    return NextResponse.json({ ok: true });
  }
}
