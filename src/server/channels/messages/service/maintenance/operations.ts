import { GatewayEvents } from '@/server/gateway/events';
import { broadcastToUser } from '@/server/gateway/broadcast';
import { getServerEventBus } from '@/server/events/runtime';
import { buildInboxItemFromConversation, emitInboxUpdated } from '@/server/channels/inbox/events';
import {
  deleteStoredAttachmentFile,
  extractStoredAttachmentsFromMetadata,
} from '@/server/channels/messages/attachments';
import type { MessageRepository, StoredMessage } from '@/server/channels/messages/repository';
import type { SessionManager } from '@/server/channels/messages/sessionManager';
import type { RecallService } from '@/server/channels/messages/service/recall';
import type { SummaryService } from '@/server/channels/messages/service/summaryService';
import type { ChannelType } from '@/shared/domain/types';

export interface MaintenanceDeps {
  repo: MessageRepository;
  sessionManager: SessionManager;
  summaryRefreshInFlight: Set<string>;
  summaryService: SummaryService;
  recallService: RecallService;
  activeRequests: Map<string, AbortController>;
}

export function abortGeneration(
  activeRequests: Map<string, AbortController>,
  conversationId: string,
): boolean {
  const controller = activeRequests.get(conversationId);
  if (!controller) return false;
  controller.abort();
  activeRequests.delete(conversationId);
  return true;
}

export function abortAllActiveRequests(activeRequests: Map<string, AbortController>): void {
  for (const controller of activeRequests.values()) {
    controller.abort();
  }
  activeRequests.clear();
}

export function deleteConversation(
  deps: MaintenanceDeps,
  conversationId: string,
  userId: string,
): boolean {
  abortGeneration(deps.activeRequests, conversationId);
  deps.activeRequests.delete(conversationId);
  deps.summaryRefreshInFlight.delete(conversationId);
  deps.summaryService.clearInFlight(conversationId);
  deps.recallService.clearConversationState(conversationId);
  return deps.repo.deleteConversation(conversationId, userId);
}

export function deleteMessage(
  deps: MaintenanceDeps,
  messageId: string,
  userId: string,
  conversationId?: string,
): boolean {
  if (typeof deps.repo.deleteMessage !== 'function' || typeof deps.repo.getMessage !== 'function') {
    return false;
  }

  const normalizedUserId = deps.sessionManager.resolveUserId(userId);
  const message = deps.repo.getMessage(messageId, normalizedUserId);
  if (!message) {
    return false;
  }
  if (conversationId && message.conversationId !== conversationId) {
    return false;
  }

  const deleted = deps.repo.deleteMessage(messageId, normalizedUserId);
  if (!deleted) {
    return false;
  }

  for (const attachment of extractStoredAttachmentsFromMetadata(message.metadata)) {
    deleteStoredAttachmentFile(attachment);
  }

  deps.summaryRefreshInFlight.delete(message.conversationId);
  deps.summaryService.clearInFlight(message.conversationId);
  deps.recallService.clearConversationState(message.conversationId);
  return true;
}

export function saveDirectMessage(
  deps: Pick<MaintenanceDeps, 'repo' | 'sessionManager'>,
  params: {
    conversationId: string;
    role: 'user' | 'agent' | 'system';
    content: string;
    platform: ChannelType;
    userId?: string;
    metadata?: Record<string, unknown>;
  },
): StoredMessage {
  const conversation = params.userId
    ? deps.repo.getConversation(
        params.conversationId,
        deps.sessionManager.resolveUserId(params.userId),
      )
    : deps.repo.getConversation(params.conversationId);

  if (!conversation) {
    throw new Error('Conversation not found for current user.');
  }

  const msg = deps.repo.saveMessage({
    conversationId: params.conversationId,
    role: params.role,
    content: params.content,
    platform: params.platform,
    metadata: params.metadata,
  });

  getServerEventBus().publish('chat.message.persisted', {
    conversation,
    message: msg,
  });
  broadcastToUser(conversation.userId, GatewayEvents.CHAT_MESSAGE, msg);
  emitInboxUpdated({
    userId: conversation.userId,
    action: 'upsert',
    conversationId: conversation.id,
    item: buildInboxItemFromConversation(conversation, msg),
  });
  return msg;
}
