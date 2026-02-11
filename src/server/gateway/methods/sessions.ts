// ─── Session Method Handlers ────────────────────────────────
// RPC methods for session lifecycle operations over WebSocket.

import { registerMethod, type RespondFn } from '../method-router';
import type { GatewayClient } from '../client-registry';
import { ChannelType } from '../../../../types';

// ─── sessions.delete ─────────────────────────────────────────
// Delete a conversation and all its messages.

registerMethod(
  'sessions.delete',
  async (params: Record<string, unknown>, client: GatewayClient, respond: RespondFn, _ctx) => {
    const conversationId = params.conversationId as string;

    if (!conversationId) {
      throw new Error('conversationId is required');
    }

    const { getMessageService } = await import('../../channels/messages/runtime');
    const service = getMessageService();

    const deleted = service.deleteConversation(conversationId, client.userId);

    if (deleted) {
      const { broadcastToUser } = await import('../../gateway/broadcast');
      const { GatewayEvents } = await import('../../gateway/events');
      broadcastToUser(client.userId, GatewayEvents.CONVERSATION_DELETED, { conversationId });
    }

    respond({ deleted });
  },
);

// ─── sessions.reset ──────────────────────────────────────────
// Create a fresh conversation, effectively resetting the session.

registerMethod(
  'sessions.reset',
  async (params: Record<string, unknown>, client: GatewayClient, respond: RespondFn, _ctx) => {
    const title = params.title as string | undefined;

    const { getMessageService } = await import('../../channels/messages/runtime');
    const service = getMessageService();

    const newConversation = service.getOrCreateConversation(
      ChannelType.WEBCHAT,
      `manual-${client.userId}-${Date.now()}`,
      title,
      client.userId,
    );

    const { broadcastToUser } = await import('../../gateway/broadcast');
    const { GatewayEvents } = await import('../../gateway/events');
    broadcastToUser(client.userId, GatewayEvents.CONVERSATION_RESET, {
      oldConversationId: null,
      newConversationId: newConversation.id,
    });

    respond({ conversationId: newConversation.id });
  },
);

// ─── sessions.patch ──────────────────────────────────────────
// Update session properties (currently: model override).

registerMethod(
  'sessions.patch',
  async (params: Record<string, unknown>, client: GatewayClient, respond: RespondFn, _ctx) => {
    const conversationId = params.conversationId as string;

    if (!conversationId) {
      throw new Error('conversationId is required');
    }

    const { getMessageService } = await import('../../channels/messages/runtime');
    const service = getMessageService();

    // Model override — null clears the override
    if ('modelOverride' in params) {
      const modelOverride = (params.modelOverride as string) || null;
      service.setModelOverride(conversationId, modelOverride, client.userId);
    }

    respond({ ok: true });
  },
);
