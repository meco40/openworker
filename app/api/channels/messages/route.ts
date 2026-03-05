import { NextResponse } from 'next/server';
import { getMessageService } from '@/server/channels/messages/runtime';
import { getPersonaRepository } from '@/server/personas/personaRepository';
import {
  persistIncomingAttachment,
  type IncomingMessageAttachmentPayload,
  type StoredMessageAttachment,
} from '@/server/channels/messages/attachments';
import { emitInboxUpdated } from '@/server/channels/inbox/events';
import { withUserContext } from '../../_shared/withUserContext';

export const runtime = 'nodejs';

function normalizePersonaId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export const GET = withUserContext(async ({ request, userContext }) => {
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
});

export const POST = withUserContext(async ({ request, userContext }) => {
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

    const service = getMessageService();
    const conversationId =
      body.conversationId || service.getDefaultWebChatConversation(userContext.userId).id;
    const conversation = service.getConversation(conversationId, userContext.userId);

    const requestedPersonaId = normalizePersonaId(body.personaId);
    const boundPersonaId = normalizePersonaId(conversation?.personaId);
    if (requestedPersonaId && boundPersonaId && requestedPersonaId !== boundPersonaId) {
      return NextResponse.json(
        {
          ok: false,
          error: 'personaId mismatch: conversation is already bound to a different persona.',
        },
        { status: 409 },
      );
    }

    if (requestedPersonaId && conversation && !boundPersonaId) {
      service.setPersonaId(conversationId, requestedPersonaId, userContext.userId);
    }

    const effectivePersonaId = requestedPersonaId || boundPersonaId || null;
    const personaSlug = effectivePersonaId
      ? getPersonaRepository().getPersona(effectivePersonaId)?.slug || null
      : null;

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
            personaSlug,
            attachment: attachmentPayload,
          }),
        );
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Attachment could not be processed.';
        return NextResponse.json({ ok: false, error: message }, { status: 400 });
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
});

export const DELETE = withUserContext(async ({ request, userContext }) => {
  try {
    const { searchParams } = new URL(request.url);
    const messageId = searchParams.get('messageId')?.trim() || '';
    const conversationId = searchParams.get('conversationId')?.trim() || undefined;
    if (!messageId) {
      return NextResponse.json({ ok: false, error: 'messageId is required' }, { status: 400 });
    }

    const service = getMessageService();
    const existingMessage = service.getMessage(messageId, userContext.userId);
    if (!existingMessage) {
      return NextResponse.json({ ok: false, error: 'Message not found' }, { status: 404 });
    }
    if (conversationId && existingMessage.conversationId !== conversationId) {
      return NextResponse.json({ ok: false, error: 'Message not found' }, { status: 404 });
    }

    const deleted = service.deleteMessage(
      messageId,
      userContext.userId,
      existingMessage.conversationId,
    );
    if (!deleted) {
      return NextResponse.json({ ok: false, error: 'Message not found' }, { status: 404 });
    }

    const { broadcastToUser } = await import('@/server/gateway/broadcast');
    const { GatewayEvents } = await import('@/server/gateway/events');
    broadcastToUser(userContext.userId, GatewayEvents.CHAT_MESSAGE_DELETED, {
      messageId,
      conversationId: existingMessage.conversationId || null,
    });

    const inboxItem = service.getInboxItem(existingMessage.conversationId, userContext.userId);
    emitInboxUpdated({
      userId: userContext.userId,
      action: inboxItem ? 'upsert' : 'delete',
      conversationId: existingMessage.conversationId,
      item: inboxItem,
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
});
