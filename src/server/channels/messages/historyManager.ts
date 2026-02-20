import type { ChannelType } from '@/shared/domain/types';
import type { MessageRepository, StoredMessage } from '@/server/channels/messages/repository';

export class HistoryManager {
  constructor(private readonly repo: MessageRepository) {}

  appendUserMessage(
    conversationId: string,
    platform: ChannelType,
    content: string,
    options: {
      externalMsgId?: string;
      senderName?: string;
      clientMessageId?: string;
      metadata?: Record<string, unknown>;
    } = {},
  ): StoredMessage {
    return this.repo.saveMessage({
      conversationId,
      role: 'user',
      content,
      platform,
      externalMsgId: options.externalMsgId,
      senderName: options.senderName,
      clientMessageId: options.clientMessageId,
      metadata: options.metadata,
    });
  }

  appendAgentMessage(
    conversationId: string,
    platform: ChannelType,
    content: string,
    metadata?: Record<string, unknown>,
  ): StoredMessage {
    return this.repo.saveMessage({
      conversationId,
      role: 'agent',
      content,
      platform,
      metadata,
    });
  }

  listRecentMessages(conversationId: string, userId: string, limit = 50): StoredMessage[] {
    return this.repo.listMessages(conversationId, limit, undefined, userId);
  }
}
