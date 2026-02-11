import type { ChannelType } from '../../../../types';
import type { MessageRepository, StoredMessage } from './repository';

export class HistoryManager {
  constructor(private readonly repo: MessageRepository) {}

  appendUserMessage(
    conversationId: string,
    platform: ChannelType,
    content: string,
    options: { externalMsgId?: string; senderName?: string; clientMessageId?: string } = {},
  ): StoredMessage {
    return this.repo.saveMessage({
      conversationId,
      role: 'user',
      content,
      platform,
      externalMsgId: options.externalMsgId,
      senderName: options.senderName,
      clientMessageId: options.clientMessageId,
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
