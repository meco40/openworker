// --- Chat Method Handlers ----------------------------------------------------
// RPC methods for chat operations over WebSocket.

import { registerMethod, type RespondFn, type SendRawFn } from '@/server/gateway/method-router';
import { makeStream } from '@/server/gateway/protocol';
import type { GatewayClient } from '@/server/gateway/client-registry';

interface RpcAttachmentInput {
  name?: string;
  type?: string;
  size?: number;
  url?: string;
}

const DEFAULT_STREAM_KEEPALIVE_MS = 10_000;
const MIN_STREAM_KEEPALIVE_MS = 1_000;
const MAX_STREAM_KEEPALIVE_MS = 60_000;

function resolveStreamKeepaliveMs(): number {
  const raw = Number.parseInt(String(process.env.OPENCLAW_CHAT_STREAM_KEEPALIVE_MS || ''), 10);
  if (!Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_STREAM_KEEPALIVE_MS;
  }
  return Math.max(MIN_STREAM_KEEPALIVE_MS, Math.min(MAX_STREAM_KEEPALIVE_MS, raw));
}

function normalizeStringParam(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function createInvalidRequestError(message: string): Error & { code: 'INVALID_REQUEST' } {
  const error = new Error(message) as Error & { code: 'INVALID_REQUEST' };
  error.code = 'INVALID_REQUEST';
  return error;
}

function resolveConversationsListLimit(value: unknown): number {
  const defaultLimit = 50;
  const maxLimit = 200;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return defaultLimit;
  }
  const normalized = Math.floor(value);
  if (normalized < 1) {
    return defaultLimit;
  }
  return Math.min(normalized, maxLimit);
}

async function resolveWebUiMessageInput(
  params: Record<string, unknown>,
  userId: string,
): Promise<{
  service: Awaited<
    ReturnType<(typeof import('@/server/channels/messages/runtime'))['getMessageService']>
  >;
  conversationId: string;
  content: string;
  clientMessageId?: string;
  attachments?: Array<
    Awaited<
      ReturnType<
        (typeof import('@/server/channels/messages/attachments'))['persistIncomingAttachment']
      >
    >
  >;
}> {
  const conversationId = normalizeStringParam(params.conversationId).trim();
  const content = normalizeStringParam(params.content);
  const clientMessageIdRaw = normalizeStringParam(params.clientMessageId).trim();
  const clientMessageId = clientMessageIdRaw || undefined;
  const personaId = normalizeStringParam(params.personaId).trim();
  const attachment = (params.attachment as RpcAttachmentInput | undefined) || undefined;
  const hasAttachment = Boolean(attachment?.url && attachment.url.trim());

  if (!conversationId || (!content.trim() && !hasAttachment)) {
    throw new Error('conversationId and content or attachment are required');
  }

  const { getMessageService } = await import('@/server/channels/messages/runtime');
  const service = getMessageService();

  if (personaId) {
    const conversation = service.getConversation(conversationId, userId);
    const boundPersonaId = normalizeStringParam(conversation?.personaId).trim();
    if (conversation && boundPersonaId && boundPersonaId !== personaId) {
      throw createInvalidRequestError(
        'personaId mismatch: conversation is already bound to a different persona.',
      );
    }
    if (conversation && !boundPersonaId) {
      service.setPersonaId(conversationId, personaId, userId);
    }
  }
  const conversationAfterBind = service.getConversation(conversationId, userId);
  const effectivePersonaId = personaId || conversationAfterBind?.personaId || null;
  const personaSlug = effectivePersonaId
    ? (await import('@/server/personas/personaRepository'))
        .getPersonaRepository()
        .getPersona(effectivePersonaId)?.slug || null
    : null;

  let attachments:
    | Array<
        Awaited<
          ReturnType<
            (typeof import('@/server/channels/messages/attachments'))['persistIncomingAttachment']
          >
        >
      >
    | undefined;

  if (hasAttachment) {
    const { persistIncomingAttachment } = await import('@/server/channels/messages/attachments');
    const declaredSize =
      typeof attachment?.size === 'number' && Number.isFinite(attachment.size)
        ? Math.max(0, Math.floor(attachment.size))
        : 0;
    attachments = [
      persistIncomingAttachment({
        userId,
        conversationId,
        personaSlug,
        attachment: {
          name: String(attachment?.name || 'attachment'),
          type: String(attachment?.type || ''),
          size: declaredSize,
          dataUrl: String(attachment?.url || ''),
        },
      }),
    ];
  }

  return {
    service,
    conversationId,
    content,
    clientMessageId,
    attachments,
  };
}

// --- chat.send ---------------------------------------------------------------
// Send a message in a conversation. AI response is broadcast as chat.message event.

registerMethod(
  'chat.send',
  async (params: Record<string, unknown>, client: GatewayClient, respond: RespondFn, _ctx) => {
    const { service, conversationId, content, clientMessageId, attachments } =
      await resolveWebUiMessageInput(params, client.userId);

    const result = await service.handleWebUIMessage(
      conversationId,
      content,
      client.userId,
      clientMessageId,
      attachments,
    );
    respond({
      userMsgId: result.userMsg.id,
      agentMsgId: result.agentMsg.id,
      newConversationId: result.newConversationId ?? null,
    });
  },
);

// --- chat.stream -------------------------------------------------------------
// Send a message and receive the AI response as a token stream.
// Streams native deltas when the runtime provides them.
// If a runtime does not stream, the final persisted `chat.message`
// event remains the single source of truth for rendered output.

registerMethod(
  'chat.stream',
  async (
    params: Record<string, unknown>,
    client: GatewayClient,
    _respond: RespondFn,
    ctx: { requestId: string | number; sendRaw: SendRawFn },
  ) => {
    const { service, conversationId, content, clientMessageId, attachments } =
      await resolveWebUiMessageInput(params, client.userId);

    const keepaliveMs = resolveStreamKeepaliveMs();
    let streamClosed = false;
    const keepaliveTimer = setInterval(() => {
      if (streamClosed) return;
      try {
        ctx.sendRaw(makeStream(ctx.requestId, '', false));
      } catch {
        // ignore send failures, upstream lifecycle handles disconnects
      }
    }, keepaliveMs);
    keepaliveTimer.unref?.();

    try {
      const result = await service.handleWebUIMessage(
        conversationId,
        content,
        client.userId,
        clientMessageId,
        attachments,
        (delta) => {
          if (!delta) return;
          ctx.sendRaw(makeStream(ctx.requestId, delta, false));
        },
      );

      // Do not emit a synthetic fallback delta when no native stream arrived.
      // Otherwise UI can render a duplicate bubble (persisted message + fallback delta draft).
      void result;
      streamClosed = true;
      ctx.sendRaw(makeStream(ctx.requestId, '', true));
    } finally {
      clearInterval(keepaliveTimer);
    }
  },
);

// --- chat.history ------------------------------------------------------------
// Load message history for a conversation.

registerMethod(
  'chat.history',
  async (params: Record<string, unknown>, client: GatewayClient, respond: RespondFn, _ctx) => {
    const conversationId = params.conversationId as string;
    const limit = (params.limit as number) || 50;
    const before = params.before as string | undefined;

    if (!conversationId) {
      throw new Error('conversationId is required');
    }

    const { getMessageRepository } = await import('@/server/channels/messages/runtime');
    const repo = getMessageRepository();
    const messages = repo.listMessages(conversationId, limit, before, client.userId);
    respond(messages);
  },
);

// --- chat.conversations.list -------------------------------------------------
// List all conversations for the current user.

registerMethod(
  'chat.conversations.list',
  async (params: Record<string, unknown>, client: GatewayClient, respond: RespondFn, _ctx) => {
    const { getMessageRepository } = await import('@/server/channels/messages/runtime');
    const repo = getMessageRepository();
    const limit = resolveConversationsListLimit(params.limit);
    const conversations = repo.listConversations(limit, client.userId);
    respond(conversations);
  },
);

// --- chat.abort --------------------------------------------------------------
// Abort an in-flight AI generation for a conversation.

registerMethod(
  'chat.abort',
  async (params: Record<string, unknown>, client: GatewayClient, respond: RespondFn, _ctx) => {
    const conversationId = params.conversationId as string;

    if (!conversationId) {
      throw new Error('conversationId is required');
    }

    const { getMessageService } = await import('@/server/channels/messages/runtime');
    const service = getMessageService();

    const aborted = service.abortGeneration(conversationId);
    if (aborted) {
      const { broadcastToUser } = await import('@/server/gateway/broadcast');
      const { GatewayEvents } = await import('@/server/gateway/events');
      broadcastToUser(client.userId, GatewayEvents.CHAT_ABORTED, { conversationId });
    }
    respond({ aborted });
  },
);

registerMethod(
  'chat.approval.respond',
  async (params: Record<string, unknown>, client: GatewayClient, respond: RespondFn, _ctx) => {
    const conversationId = normalizeStringParam(params.conversationId).trim();
    const approvalToken = normalizeStringParam(params.approvalToken).trim();
    const approved = Boolean(params.approved);
    const approveAlways = Boolean(params.approveAlways);
    const toolId = normalizeStringParam(params.toolId).trim() || undefined;
    const toolFunctionName = normalizeStringParam(params.toolFunctionName).trim() || undefined;

    if (!conversationId) {
      throw new Error('conversationId is required');
    }
    if (!approvalToken) {
      throw new Error('approvalToken is required');
    }

    const { getMessageService } = await import('@/server/channels/messages/runtime');
    const service = getMessageService();
    const result = await service.respondToolApproval({
      conversationId,
      userId: client.userId,
      approvalToken,
      approved,
      approveAlways,
      toolId,
      toolFunctionName,
    });
    respond(result);
  },
);
