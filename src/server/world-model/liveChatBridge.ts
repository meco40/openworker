import type { Conversation, StoredMessage } from '@/server/channels/messages/repository';
import { bridgeChatMessages } from '@/server/world-model/bridge';

/**
 * Sends a persisted chat message through the canonical observation writer.
 * The SQLite message id is the stable source identity shared by live traffic
 * and historical backfill; replaying the same message is therefore a no-op.
 */
export function bridgeStoredChatMessage(input: {
  conversation: Conversation;
  message: StoredMessage;
}): Promise<{ written: number; skipped: number }> {
  const { conversation, message } = input;
  if (!conversation.personaId) return Promise.resolve({ written: 0, skipped: 1 });

  return bridgeChatMessages({
    conversationId: conversation.id,
    userId: conversation.userId,
    personaId: conversation.personaId,
    workspaceId: conversation.workspaceId ?? '',
    messages: [
      {
        id: message.id,
        userId: conversation.userId,
        personaId: conversation.personaId,
        conversationId: message.conversationId,
        seq: message.seq ?? 0,
        role: message.role,
        content: message.content,
        createdAt: message.createdAt,
        sourceId: message.id,
        channelType: message.platform,
        senderId: message.senderName ?? undefined,
      },
    ],
  });
}
