import type { Conversation } from '@/shared/domain/types';
import type { StoredMessage } from '@/server/channels/messages/repository';

export interface ServerEventMap {
  'chat.message.persisted': {
    conversation: Conversation;
    message: StoredMessage;
  };
  'chat.summary.refreshed': {
    conversationId: string;
    userId: string;
    personaId: string | null;
    summaryText: string;
    summaryUptoSeq: number;
    messages: StoredMessage[];
    createdAt: string;
  };
}

export type ServerEventName = keyof ServerEventMap;
