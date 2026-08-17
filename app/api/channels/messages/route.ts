import { NextResponse } from 'next/server';
import { getMessageService } from '@/server/channels/messages/runtime';
import { getPersonaRepository } from '@/server/personas/personaRepository';
import {
  persistIncomingAttachment,
  type IncomingMessageAttachmentPayload,
  type StoredMessageAttachment,
} from '@/server/channels/messages/attachments';
import {
  getChatDisplaySlowThresholdMs,
  logChatDisplayTrace,
} from '@/server/diagnostics/chatDisplayTrace';
import { deleteMessageWithSideEffects } from '@/server/channels/messages/deleteMessageAction';
import { withUserContext } from '../../_shared/withUserContext';

export const runtime = 'nodejs';

function normalizePersonaId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export const GET = withUserContext(async ({ request, userContext }) => {
  const startedAt = Date.now();
  const { searchParams } = new URL(request.url);
  const conversationId = searchParams.get('conversationId');
  const limit = parseInt(searchParams.get('limit') || '100', 10);
  const before = searchParams.get('before') || undefined;

  const serviceStartedAt = Date.now();
  const service = getMessageService();
  const serviceResolveDurationMs = Date.now() - serviceStartedAt;

  if (!conversationId) {
    // Return default webchat messages
    const defaultConversationStartedAt = Date.now();
    const conv = service.getDefaultWebChatConversation(userContext.userId);
    const defaultConversationDurationMs = Date.now() - defaultConversationStartedAt;
    const listStartedAt = Date.now();
    const messages = service.listMessages(conv.id, userContext.userId, limit, before);
    const listMessagesDurationMs = Date.now() - listStartedAt;
    const durationMs = Date.now() - startedAt;
    logChatDisplayTrace(
      'http.messages.complete',
      {
        path: '/api/channels/messages',
        userId: userContext.userId,
        conversationId: conv.id,
        requestedDefaultConversation: true,
        limit,
        hasBefore: Boolean(before),
        returned: messages.length,
        durationMs,
        serviceResolveDurationMs,
        defaultConversationDurationMs,
        listMessagesDurationMs,
      },
      { force: durationMs >= getChatDisplaySlowThresholdMs() },
    );
    return NextResponse.json({ ok: true, conversationId: conv.id, messages });
  }

  const listStartedAt = Date.now();
  const messages = service.listMessages(conversationId, userContext.userId, limit, before);
  const listMessagesDurationMs = Date.now() - listStartedAt;
  const durationMs = Date.now() - startedAt;
  logChatDisplayTrace(
    'http.messages.complete',
    {
      path: '/api/channels/messages',
      userId: userContext.userId,
      conversationId,
      requestedDefaultConversation: false,
      limit,
      hasBefore: Boolean(before),
      returned: messages.length,
      durationMs,
      serviceResolveDurationMs,
      listMessagesDurationMs,
    },
    { force: durationMs >= getChatDisplaySlowThresholdMs() },
  );
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
    const result = await deleteMessageWithSideEffects({
      service,
      messageId,
      userId: userContext.userId,
      conversationId,
    });
    if (!result.ok) {
      return NextResponse.json({ ok: false, error: 'Message not found' }, { status: 404 });
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
});
