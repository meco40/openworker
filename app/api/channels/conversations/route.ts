import { NextResponse } from 'next/server';
import { getMessageService } from '../../../../src/server/channels/messages/runtime';
import type { ChannelType } from '../../../../types';
import { resolveRequestUserContext } from '../../../../src/server/auth/userContext';
import { isPersistentSessionV2Enabled } from '../../../../src/server/channels/messages/featureFlag';

export const runtime = 'nodejs';

export async function GET() {
  if (!isPersistentSessionV2Enabled()) {
    const service = getMessageService();
    service.getDefaultWebChatConversation();
    const conversations = service.listConversations();
    return NextResponse.json({ ok: true, conversations });
  }

  const userContext = await resolveRequestUserContext();
  if (!userContext) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  const service = getMessageService();

  // Ensure a default WebChat conversation always exists so the UI input is never disabled
  service.getDefaultWebChatConversation(userContext.userId);

  const conversations = service.listConversations(userContext.userId);
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

    if (!isPersistentSessionV2Enabled()) {
      const service = getMessageService();
      const conversation = service.getOrCreateConversation(
        body.channelType,
        `manual-${Date.now()}`,
        body.title,
      );
      return NextResponse.json({ ok: true, conversation });
    }

    const userContext = await resolveRequestUserContext();
    if (!userContext) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    const service = getMessageService();
    const conversation = service.getOrCreateConversation(
      body.channelType,
      `manual-${userContext.userId}-${Date.now()}`,
      body.title,
      userContext.userId,
    );

    return NextResponse.json({ ok: true, conversation });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
