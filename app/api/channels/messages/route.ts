import { NextResponse } from 'next/server';
import { getMessageService } from '../../../../src/server/channels/messages/runtime';
import { resolveRequestUserContext } from '../../../../src/server/auth/userContext';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  const userContext = await resolveRequestUserContext();
  if (!userContext) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const conversationId = searchParams.get('conversationId');
  const limit = parseInt(searchParams.get('limit') || '100', 10);
  const before = searchParams.get('before') || undefined;

  const service = getMessageService();

  if (!conversationId) {
    // Return default webchat messages
    const conv = service.getDefaultWebChatConversation(userContext.userId);
    const messages = service.listMessages(conv.id, userContext.userId, limit, before);
    return NextResponse.json({ ok: true, conversationId: conv.id, messages });
  }

  const messages = service.listMessages(conversationId, userContext.userId, limit, before);
  return NextResponse.json({ ok: true, conversationId, messages });
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      conversationId?: string;
      content?: string;
      clientMessageId?: string;
      personaId?: string;
    };

    if (!body.content?.trim()) {
      return NextResponse.json({ ok: false, error: 'content is required' }, { status: 400 });
    }

    const userContext = await resolveRequestUserContext();
    if (!userContext) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    const service = getMessageService();
    const conversationId =
      body.conversationId || service.getDefaultWebChatConversation(userContext.userId).id;
    
    // If personaId provided and conversation doesn't have one, bind it
    if (body.personaId) {
      const conversation = service.getConversation(conversationId, userContext.userId);
      if (conversation && !conversation.personaId) {
        service.setPersonaId(conversationId, body.personaId, userContext.userId);
      }
    }
    
    const result = await service.handleWebUIMessage(
      conversationId,
      body.content,
      userContext.userId,
      body.clientMessageId,
    );

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
