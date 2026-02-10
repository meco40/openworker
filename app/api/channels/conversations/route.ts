import { NextResponse } from 'next/server';
import { getMessageService } from '../../../../src/server/channels/messages/runtime';
import type { ChannelType } from '../../../../types';

export const runtime = 'nodejs';

export async function GET() {
  const service = getMessageService();

  // Ensure a default WebChat conversation always exists so the UI input is never disabled
  service.getDefaultWebChatConversation();

  const conversations = service.listConversations();
  return NextResponse.json({ ok: true, conversations });
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      channelType?: ChannelType;
      title?: string;
    };

    if (!body.channelType) {
      return NextResponse.json({ ok: false, error: 'channelType is required' }, { status: 400 });
    }

    const service = getMessageService();
    const conversation = service.getOrCreateConversation(
      body.channelType,
      `manual-${Date.now()}`,
      body.title,
    );

    return NextResponse.json({ ok: true, conversation });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
