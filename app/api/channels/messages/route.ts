import { NextResponse } from 'next/server';
import { getMessageService } from '../../../../src/server/channels/messages/runtime';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const conversationId = searchParams.get('conversationId');
  const limit = parseInt(searchParams.get('limit') || '100', 10);
  const before = searchParams.get('before') || undefined;

  const service = getMessageService();

  if (!conversationId) {
    // Return default webchat messages
    const conv = service.getDefaultWebChatConversation();
    const messages = service.listMessages(conv.id, limit, before);
    return NextResponse.json({ ok: true, conversationId: conv.id, messages });
  }

  const messages = service.listMessages(conversationId, limit, before);
  return NextResponse.json({ ok: true, conversationId, messages });
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      conversationId?: string;
      content?: string;
    };

    if (!body.content?.trim()) {
      return NextResponse.json({ ok: false, error: 'content is required' }, { status: 400 });
    }

    const service = getMessageService();
    const conversationId = body.conversationId || service.getDefaultWebChatConversation().id;
    const result = await service.handleWebUIMessage(conversationId, body.content);

    return NextResponse.json({
      ok: true,
      userMessage: result.userMsg,
      agentMessage: result.agentMsg,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
