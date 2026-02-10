import { NextResponse } from 'next/server';
import { getMessageService } from '../../../../../src/server/channels/messages/runtime';
import { verifySharedSecret } from '../../../../../src/server/channels/webhookAuth';
import { ChannelType } from '../../../../../types';

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

    if (!payload.body?.trim()) {
      return NextResponse.json({ ok: true });
    }

    const chatId = payload.chatId || payload.from || 'unknown';
    const text = payload.body;
    const senderName = payload.senderName || payload.from || 'WhatsApp User';

    const service = getMessageService();
    await service.handleInbound(ChannelType.WHATSAPP, chatId, text, senderName, payload.messageId);

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('WhatsApp webhook error:', error);
    return NextResponse.json({ ok: true });
  }
}
