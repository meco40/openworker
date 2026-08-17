import type { StoredMessage } from '@/server/channels/messages/repository';
import type { MessageService } from '@/server/channels/messages/service';
import { emitInboxUpdated } from '@/server/channels/inbox/events';
import { broadcastToUser } from '@/server/gateway/broadcast';
import { GatewayEvents } from '@/server/gateway/events';

export type DeleteMessageActionResult =
  | {
      ok: true;
      deletedMessage: StoredMessage;
    }
  | {
      ok: false;
      error: 'not_found';
    };

export async function deleteMessageWithSideEffects(params: {
  service: MessageService;
  messageId: string;
  userId: string;
  conversationId?: string;
}): Promise<DeleteMessageActionResult> {
  const { service, messageId, userId, conversationId } = params;
  const existingMessage = service.getMessage(messageId, userId);
  if (!existingMessage) {
    return { ok: false, error: 'not_found' };
  }

  if (conversationId && existingMessage.conversationId !== conversationId) {
    return { ok: false, error: 'not_found' };
  }

  const deleted = service.deleteMessage(messageId, userId, existingMessage.conversationId);
  if (!deleted) {
    return { ok: false, error: 'not_found' };
  }

  broadcastToUser(userId, GatewayEvents.CHAT_MESSAGE_DELETED, {
    messageId,
    conversationId: existingMessage.conversationId || null,
  });

  const inboxItem = service.getInboxItem(existingMessage.conversationId, userId);
  emitInboxUpdated({
    userId,
    action: inboxItem ? 'upsert' : 'delete',
    conversationId: existingMessage.conversationId,
    item: inboxItem,
  });

  return {
    ok: true,
    deletedMessage: existingMessage,
  };
}
