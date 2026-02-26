import type { ChannelType } from '@/shared/domain/types';
import type {
  Conversation,
  MessageRepository,
  StoredMessage,
} from '@/server/channels/messages/repository';
import type { SessionManager } from '@/server/channels/messages/sessionManager';
import { isAgentRoomConversationRecord } from '@/server/channels/messages/service/routing/modelRouting';

export interface ConversationOperationDeps {
  repo: MessageRepository;
  sessionManager: SessionManager;
}

export function listConversations(
  deps: ConversationOperationDeps,
  userId?: string,
  limit?: number,
): Conversation[] {
  const resolvedUserId = deps.sessionManager.resolveUserId(userId);
  return deps.repo.listConversations(limit, resolvedUserId);
}

export function getOrCreateConversation(
  deps: ConversationOperationDeps,
  channelType: ChannelType,
  externalChatId: string,
  title?: string,
  userId?: string,
): Conversation {
  return deps.sessionManager.getOrCreateConversation(
    deps.repo,
    channelType,
    externalChatId,
    title,
    userId,
  );
}

export function getDefaultWebChatConversation(
  deps: ConversationOperationDeps,
  userId?: string,
): Conversation {
  const resolvedUserId = deps.sessionManager.resolveUserId(userId);
  return deps.repo.getDefaultWebChatConversation(resolvedUserId);
}

export function getConversation(
  deps: ConversationOperationDeps,
  conversationId: string,
  userId?: string,
): Conversation | null {
  const resolvedUserId = deps.sessionManager.resolveUserId(userId);
  return deps.repo.getConversation(conversationId, resolvedUserId);
}

export function isAgentRoomConversation(
  deps: ConversationOperationDeps,
  conversationId: string,
  userId?: string,
): boolean {
  const conversation = getConversation(deps, conversationId, userId);
  if (!conversation) return false;
  return isAgentRoomConversationRecord(conversation, deps.repo);
}

export function listMessages(
  deps: ConversationOperationDeps,
  conversationId: string,
  userId?: string,
  limit?: number,
  before?: string,
): StoredMessage[] {
  const resolvedUserId = deps.sessionManager.resolveUserId(userId);
  return deps.repo.listMessages(conversationId, limit, before, resolvedUserId);
}

export function getMessage(
  deps: ConversationOperationDeps,
  messageId: string,
  userId?: string,
): StoredMessage | null {
  const resolvedUserId = deps.sessionManager.resolveUserId(userId);
  if (deps.repo.getMessage) {
    return deps.repo.getMessage(messageId, resolvedUserId);
  }
  return null;
}
