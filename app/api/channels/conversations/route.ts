import { NextResponse } from 'next/server';
import { getMessageService } from '@/server/channels/messages/runtime';
import type { ChannelType } from '@/shared/domain/types';
import { emitInboxUpdated } from '@/server/channels/inbox/events';
import { withUserContext } from '../../_shared/withUserContext';

export const runtime = 'nodejs';

function normalizePersonaId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export const GET = withUserContext(async ({ userContext }) => {
  const service = getMessageService();

  // Ensure a default WebChat conversation always exists so the UI input is never disabled
  service.getDefaultWebChatConversation(userContext.userId);

  const conversations = service.listConversations(userContext.userId);
  return NextResponse.json({ ok: true, conversations });
});

export const POST = withUserContext(async ({ request, userContext }) => {
  try {
    const body = (await request.json()) as {
      channelType?: ChannelType;
      title?: string;
      personaId?: string;
    };

    if (!body.channelType) {
      return NextResponse.json({ ok: false, error: 'channelType is required' }, { status: 400 });
    }

    const service = getMessageService();
    const conversation = service.getOrCreateConversation(
      body.channelType,
      `manual-${userContext.userId}-${Date.now()}`,
      body.title,
      userContext.userId,
    );

    // Bind persona to conversation if provided
    if (body.personaId) {
      service.setPersonaId(conversation.id, body.personaId, userContext.userId);
      conversation.personaId = body.personaId;
    }

    emitInboxUpdated({
      userId: userContext.userId,
      action: 'upsert',
      conversationId: conversation.id,
      item: {
        conversationId: conversation.id,
        channelType: conversation.channelType,
        title: conversation.title,
        updatedAt: conversation.updatedAt,
        lastMessage: null,
      },
    });

    return NextResponse.json({ ok: true, conversation });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
});

// ─── DELETE /api/channels/conversations?id=<conversationId> ──
export const DELETE = withUserContext(async ({ request, userContext }) => {
  try {
    const conversationId = new URL(request.url).searchParams.get('id');
    if (!conversationId) {
      return NextResponse.json({ ok: false, error: 'id query param is required' }, { status: 400 });
    }

    const service = getMessageService();
    const deleted = service.deleteConversation(conversationId, userContext.userId);

    if (!deleted) {
      return NextResponse.json({ ok: false, error: 'Conversation not found' }, { status: 404 });
    }

    const { broadcastToUser } = await import('@/server/gateway/broadcast');
    const { GatewayEvents } = await import('@/server/gateway/events');
    broadcastToUser(userContext.userId, GatewayEvents.CONVERSATION_DELETED, { conversationId });
    emitInboxUpdated({
      userId: userContext.userId,
      action: 'delete',
      conversationId,
      item: null,
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
});

// ─── PATCH /api/channels/conversations ───────────────────────
// Body: { conversationId, modelOverride?: string | null, personaId?: string | null }
export const PATCH = withUserContext(async ({ request, userContext }) => {
  try {
    const body = (await request.json()) as {
      conversationId?: string;
      modelOverride?: string | null;
      personaId?: string | null;
    };

    if (!body.conversationId) {
      return NextResponse.json({ ok: false, error: 'conversationId is required' }, { status: 400 });
    }

    const service = getMessageService();

    if ('modelOverride' in body) {
      service.setModelOverride(body.conversationId, body.modelOverride ?? null, userContext.userId);
    }

    if ('personaId' in body) {
      const conversation = service.getConversation(body.conversationId, userContext.userId);
      const currentPersonaId = normalizePersonaId(conversation?.personaId);
      const requestedPersonaId = normalizePersonaId(body.personaId);

      if (currentPersonaId && currentPersonaId !== requestedPersonaId) {
        return NextResponse.json(
          {
            ok: false,
            error: 'personaId mismatch: conversation is already bound to a different persona.',
          },
          { status: 409 },
        );
      }

      service.setPersonaId(body.conversationId, requestedPersonaId, userContext.userId);
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
});
