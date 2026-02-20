import { NextResponse } from 'next/server';
import { getMessageService } from '@/server/channels/messages/runtime';
import { verifyDiscordWebhook } from '@/server/channels/webhookAuth';
import { ChannelType } from '@/shared/domain/types';
import { normalizeDiscordInbound } from '@/server/channels/inbound/normalizers';

export const runtime = 'nodejs';

interface DiscordWebhookPayload {
  type?: number; // 1 = PING, etc.
  channel_id?: string;
  content?: string;
  author?: { id: string; username: string };
  id?: string;
}

export async function POST(request: Request) {
  try {
    const body = await request.text();

    // Verify Discord signature
    const publicKey = process.env.DISCORD_PUBLIC_KEY || '';
    if (publicKey) {
      const valid = await verifyDiscordWebhook(request, publicKey, body);
      if (!valid) {
        return NextResponse.json({ ok: false, error: 'Invalid signature' }, { status: 401 });
      }
    }

    const payload = JSON.parse(body) as DiscordWebhookPayload;

    // Handle Discord PING verification
    if (payload.type === 1) {
      return NextResponse.json({ type: 1 });
    }

    if (!payload.content?.trim() || !payload.channel_id) {
      return NextResponse.json({ ok: true });
    }

    // Skip messages from bots (our own responses)
    if (!payload.author?.id) {
      return NextResponse.json({ ok: true });
    }

    const envelope = normalizeDiscordInbound(payload);
    if (!envelope) {
      return NextResponse.json({ ok: true });
    }

    const service = getMessageService();
    await service.handleInbound(
      ChannelType.DISCORD,
      envelope.externalChatId,
      envelope.content,
      envelope.senderName || undefined,
      envelope.externalMessageId || undefined,
    );

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('Discord webhook error:', error);
    return NextResponse.json({ ok: true });
  }
}
