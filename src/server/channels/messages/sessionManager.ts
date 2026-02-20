import type { ChannelType, Conversation } from '@/shared/domain/types';
import type { MessageRepository } from '@/server/channels/messages/repository';
import { LEGACY_LOCAL_USER_ID } from '@/server/auth/constants';

export class SessionManager {
  resolveUserId(userId?: string): string {
    const normalized = userId?.trim();
    return normalized ? normalized : LEGACY_LOCAL_USER_ID;
  }

  resolveConversationForWebChat(
    repo: MessageRepository,
    conversationId: string | undefined,
    userId?: string,
  ): Conversation {
    const resolvedUserId = this.resolveUserId(userId);

    if (!conversationId) {
      return repo.getDefaultWebChatConversation(resolvedUserId);
    }

    const conversation = repo.getConversation(conversationId, resolvedUserId);
    if (!conversation) {
      throw new Error('Conversation not found for current user.');
    }

    return conversation;
  }

  getOrCreateConversation(
    repo: MessageRepository,
    channelType: ChannelType,
    externalChatId: string,
    title?: string,
    userId?: string,
  ): Conversation {
    return repo.getOrCreateConversation(
      channelType,
      externalChatId,
      title,
      this.resolveUserId(userId),
    );
  }
}
