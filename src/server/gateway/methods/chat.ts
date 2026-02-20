// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Chat Method Handlers Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
// RPC methods for chat operations over WebSocket.

import { registerMethod, type RespondFn, type SendRawFn } from '../method-router';
import { makeStream } from '../protocol';
import type { GatewayClient } from '../client-registry';

interface RpcAttachmentInput {
  name?: string;
  type?: string;
  size?: number;
  url?: string;
}

function normalizeStringParam(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

async function resolveWebUiMessageInput(params: Record<string, unknown>, userId: string): Promise<{
  service: Awaited<ReturnType<typeof import('../../channels/messages/runtime')['getMessageService']>>;
  conversationId: string;
  content: string;
  clientMessageId?: string;
  attachments?: Array<
    Awaited<
      ReturnType<typeof import('../../channels/messages/attachments')['persistIncomingAttachment']>
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

  const { getMessageService } = await import('../../channels/messages/runtime');
  const service = getMessageService();

  if (personaId) {
    const conversation = service.getConversation(conversationId, userId);
    if (conversation && !conversation.personaId) {
      service.setPersonaId(conversationId, personaId, userId);
    }
  }

  let attachments:
    | Array<
        Awaited<
          ReturnType<typeof import('../../channels/messages/attachments')['persistIncomingAttachment']>
        >
      >
    | undefined;

  if (hasAttachment) {
    const { persistIncomingAttachment } = await import('../../channels/messages/attachments');
    const declaredSize =
      typeof attachment?.size === 'number' && Number.isFinite(attachment.size)
        ? Math.max(0, Math.floor(attachment.size))
        : 0;
    attachments = [
      persistIncomingAttachment({
        userId,
        conversationId,
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

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ chat.send Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
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

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ chat.stream Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
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
    ctx.sendRaw(makeStream(ctx.requestId, '', true));
  },
);

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ chat.history Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
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

    const { getMessageRepository } = await import('../../channels/messages/runtime');
    const repo = getMessageRepository();
    const messages = repo.listMessages(conversationId, limit, before);
    respond(messages);
  },
);

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ chat.conversations.list Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
// List all conversations for the current user.

registerMethod(
  'chat.conversations.list',
  async (_params: Record<string, unknown>, client: GatewayClient, respond: RespondFn, _ctx) => {
    const { getMessageRepository } = await import('../../channels/messages/runtime');
    const repo = getMessageRepository();
    const conversations = repo.listConversations(50, client.userId);
    respond(conversations);
  },
);

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ chat.abort Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
// Abort an in-flight AI generation for a conversation.

registerMethod(
  'chat.abort',
  async (params: Record<string, unknown>, client: GatewayClient, respond: RespondFn, _ctx) => {
    const conversationId = params.conversationId as string;

    if (!conversationId) {
      throw new Error('conversationId is required');
    }

    const { getMessageService } = await import('../../channels/messages/runtime');
    const service = getMessageService();

    const aborted = service.abortGeneration(conversationId);
    if (aborted) {
      const { broadcastToUser } = await import('../../gateway/broadcast');
      const { GatewayEvents } = await import('../../gateway/events');
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

    const { getMessageService } = await import('../../channels/messages/runtime');
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

