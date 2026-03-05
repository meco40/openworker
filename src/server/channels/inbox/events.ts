import { GatewayEvents } from '@/server/gateway/events';
import { broadcastToUser } from '@/server/gateway/broadcast';
import type {
  Conversation,
  InboxItemRecord,
  StoredMessage,
} from '@/server/channels/messages/repository';
import {
  recordInboxEventLatency,
  logInboxObservability,
  recordInboxEventDropped,
  recordInboxEventEmission,
} from './observability';

type InboxAction = 'upsert' | 'delete';

function areInboxEventsEnabled(): boolean {
  return String(process.env.INBOX_V2_EVENTS_ENABLED || 'true').toLowerCase() !== 'false';
}

export function buildInboxItemFromConversation(
  conversation: Conversation,
  lastMessage: Pick<
    StoredMessage,
    'id' | 'role' | 'content' | 'createdAt' | 'platform'
  > | null = null,
): InboxItemRecord {
  return {
    conversationId: conversation.id,
    channelType: conversation.channelType,
    title: conversation.title,
    updatedAt: conversation.updatedAt,
    lastMessage: lastMessage
      ? {
          id: lastMessage.id,
          role: lastMessage.role,
          content: lastMessage.content,
          createdAt: lastMessage.createdAt,
          platform: lastMessage.platform,
        }
      : null,
  };
}

export function emitInboxUpdated(params: {
  userId: string;
  action: InboxAction;
  conversationId: string;
  item: InboxItemRecord | null;
}): void {
  const startedAt = Date.now();
  if (!areInboxEventsEnabled()) {
    recordInboxEventDropped();
    logInboxObservability('event.dropped', {
      action: params.action,
      conversationId: params.conversationId,
      reason: 'events_disabled',
    });
    return;
  }

  const payload = {
    version: 'v2' as const,
    action: params.action,
    conversationId: params.conversationId,
    item: params.item,
    serverTs: new Date().toISOString(),
  };

  recordInboxEventEmission(params.action);
  recordInboxEventLatency(Date.now() - startedAt);
  logInboxObservability('event.emit', {
    action: params.action,
    conversationId: params.conversationId,
  });
  broadcastToUser(params.userId, GatewayEvents.INBOX_UPDATED, payload);
}
