import { NextResponse } from 'next/server';

import { ChannelType } from '../../../../../types';
import { getMessageService } from '../../../../../src/server/channels/messages/runtime';
import { verifySharedSecret } from '../../../../../src/server/channels/webhookAuth';

export const runtime = 'nodejs';

interface SlackWebhookPayload {
  type?: string;
  challenge?: string;
  event?: {
    type?: string;
    subtype?: string;
    text?: string;
    channel?: string;
    user?: string;
    ts?: string;
  };
}

export async function POST(request: Request) {
  try {
    const secret = process.env.SLACK_WEBHOOK_SECRET || '';
    if (!verifySharedSecret(request, secret)) {
      return NextResponse.json({ ok: false, error: 'Forbidden' }, { status: 403 });
    }

    const payload = (await request.json()) as SlackWebhookPayload;

    if (payload.type === 'url_verification' && payload.challenge) {
      return NextResponse.json({ challenge: payload.challenge });
    }

    if (
      payload.type !== 'event_callback' ||
      !payload.event ||
      payload.event.type !== 'message' ||
      payload.event.subtype === 'bot_message' ||
      !payload.event.channel ||
      !payload.event.text?.trim()
    ) {
      return NextResponse.json({ ok: true });
    }

    const service = getMessageService();
    await service.handleInbound(
      ChannelType.SLACK,
      payload.event.channel,
      payload.event.text,
      payload.event.user || 'Slack User',
      payload.event.ts,
    );

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('Slack webhook error:', error);
    return NextResponse.json({ ok: true });
  }
}
