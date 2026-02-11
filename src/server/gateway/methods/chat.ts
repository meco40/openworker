// ─── Chat Method Handlers ────────────────────────────────────
// RPC methods for chat operations over WebSocket.

import { registerMethod, type RespondFn, type SendRawFn } from '../method-router';
import { makeStream } from '../protocol';
import type { GatewayClient } from '../client-registry';

// ─── chat.send ───────────────────────────────────────────────
// Send a message in a conversation. AI response is broadcast as chat.message event.

registerMethod(
  'chat.send',
  async (params: Record<string, unknown>, client: GatewayClient, respond: RespondFn, _ctx) => {
    const conversationId = params.conversationId as string;
    const content = params.content as string;
    const clientMessageId = params.clientMessageId as string | undefined;

    if (!conversationId || !content) {
      throw new Error('conversationId and content are required');
    }

    const { getMessageService } = await import('../../channels/messages/runtime');
    const service = getMessageService();

    const result = await service.handleWebUIMessage(conversationId, content, client.userId, clientMessageId);
    respond({
      userMsgId: result.userMsg.id,
      agentMsgId: result.agentMsg.id,
      newConversationId: result.newConversationId ?? null,
    });
  },
);

// ─── chat.stream ─────────────────────────────────────────────
// Send a message and receive the AI response as a token stream.
// Currently the model hub returns batch responses, so we simulate
// streaming by emitting StreamFrames with chunked content.
// When the model hub adds native streaming, this handler will
// pipe real tokens without any client-side changes.

registerMethod(
  'chat.stream',
  async (
    params: Record<string, unknown>,
    client: GatewayClient,
    _respond: RespondFn,
    ctx: { requestId: string | number; sendRaw: SendRawFn },
  ) => {
    const conversationId = params.conversationId as string;
    const content = params.content as string;
    const clientMessageId = params.clientMessageId as string | undefined;

    if (!conversationId || !content) {
      throw new Error('conversationId and content are required');
    }

    const { getMessageService } = await import('../../channels/messages/runtime');
    const service = getMessageService();

    const result = await service.handleWebUIMessage(conversationId, content, client.userId, clientMessageId);
    const agentContent = result.agentMsg.content || '';

    // Emit the response as StreamFrames (chunked by words for natural UX)
    const words = agentContent.split(/(\s+)/);
    let buffer = '';
    const CHUNK_SIZE = 4; // words per frame

    for (let i = 0; i < words.length; i++) {
      buffer += words[i];
      if ((i + 1) % CHUNK_SIZE === 0 || i === words.length - 1) {
        const done = i === words.length - 1;
        ctx.sendRaw(makeStream(ctx.requestId, buffer, done));
        buffer = '';
        // Small delay between chunks for natural streaming feel
        if (!done) {
          await new Promise((resolve) => setTimeout(resolve, 15));
        }
      }
    }

    // If agentContent was empty, send a single done frame
    if (agentContent.length === 0) {
      ctx.sendRaw(makeStream(ctx.requestId, '', true));
    }
  },
);

// ─── chat.history ────────────────────────────────────────────
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

// ─── chat.conversations.list ─────────────────────────────────
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

// ─── chat.abort ──────────────────────────────────────────────
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
