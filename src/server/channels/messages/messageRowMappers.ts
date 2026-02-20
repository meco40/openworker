import { ChannelType } from '@/shared/domain/types';
import { LEGACY_LOCAL_USER_ID } from '@/server/auth/constants';
import type { Conversation, StoredMessage } from '@/server/channels/messages/repository';
import type { ChannelBinding, ChannelBindingStatus } from '@/server/channels/messages/channelBindings';
import type { ChannelKey } from '@/server/channels/adapters/types';

export function toConversation(row: Record<string, unknown>): Conversation {
  return {
    id: row.id as string,
    channelType: row.channel_type as ChannelType,
    externalChatId: (row.external_chat_id as string) || null,
    userId: (row.user_id as string) || LEGACY_LOCAL_USER_ID,
    title: row.title as string,
    modelOverride: (row.model_override as string) || null,
    personaId: (row.persona_id as string) || null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export function toMessage(row: Record<string, unknown>): StoredMessage {
  return {
    id: row.id as string,
    conversationId: row.conversation_id as string,
    seq: typeof row.seq === 'number' ? (row.seq as number) : null,
    role: row.role as 'user' | 'agent' | 'system',
    content: row.content as string,
    platform: row.platform as ChannelType,
    externalMsgId: (row.external_msg_id as string) || null,
    senderName: (row.sender_name as string) || null,
    metadata: (row.metadata as string) || null,
    createdAt: row.created_at as string,
  };
}

export function toChannelBinding(row: Record<string, unknown>): ChannelBinding {
  return {
    userId: row.user_id as string,
    channel: row.channel as ChannelKey,
    status: row.status as ChannelBindingStatus,
    externalPeerId: (row.external_peer_id as string) || null,
    peerName: (row.peer_name as string) || null,
    transport: (row.transport as string) || null,
    metadata: (row.metadata as string) || null,
    personaId: (row.persona_id as string) || null,
    lastSeenAt: (row.last_seen_at as string) || null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}
