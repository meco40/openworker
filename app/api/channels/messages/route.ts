import { NextResponse } from 'next/server';
import { getMessageService } from '../../../../src/server/channels/messages/runtime';
import { resolveRequestUserContext } from '../../../../src/server/auth/userContext';
import {
  persistIncomingAttachment,
  type IncomingMessageAttachmentPayload,
  type StoredMessageAttachment,
} from '../../../../src/server/channels/messages/attachments';

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
      attachment?: {
        name?: string;
        type?: string;
        size?: number;
        url?: string;
      };
    };

    const userContext = await resolveRequestUserContext();
    if (!userContext) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    const service = getMessageService();
    const conversationId =
      body.conversationId || service.getDefaultWebChatConversation(userContext.userId).id;

    const content = String(body.content || '');
    const trimmedContent = content.trim();
    const hasAttachment = Boolean(body.attachment?.url?.trim());
    if (!trimmedContent && !hasAttachment) {
      return NextResponse.json(
        { ok: false, error: 'content or attachment is required' },
        { status: 400 },
      );
    }

    const attachments: StoredMessageAttachment[] = [];
    if (hasAttachment) {
      try {
        const attachmentPayload: IncomingMessageAttachmentPayload = {
          name: String(body.attachment?.name || 'attachment'),
          type: String(body.attachment?.type || ''),
          size:
            typeof body.attachment?.size === 'number' && Number.isFinite(body.attachment.size)
              ? Math.max(0, Math.floor(body.attachment.size))
              : 0,
          dataUrl: String(body.attachment?.url || ''),
        };
        attachments.push(
          persistIncomingAttachment({
            userId: userContext.userId,
            conversationId,
            attachment: attachmentPayload,
          }),
        );
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Attachment could not be processed.';
        return NextResponse.json({ ok: false, error: message }, { status: 400 });
      }
    }
    
    // If personaId provided and conversation doesn't have one, bind it
    if (body.personaId) {
      const conversation = service.getConversation(conversationId, userContext.userId);
      if (conversation && !conversation.personaId) {
        service.setPersonaId(conversationId, body.personaId, userContext.userId);
      }
    }
    
    const result = await service.handleWebUIMessage(
      conversationId,
      trimmedContent,
      userContext.userId,
      body.clientMessageId,
      attachments.length > 0 ? attachments : undefined,
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
