import type { Conversation } from '@/shared/domain/types';
import type { StoredMessage } from '@/server/channels/messages/repository';

import type { MasterInvalidationResource } from '@/shared/eventsTypes';

export type { MasterInvalidationResource } from '@/shared/eventsTypes';

export interface ServerEventMap {
  'memory.lifecycle.changed': {
    memoryId: string;
    userId: string;
    personaId: string;
    status: 'new' | 'confirmed' | 'stale' | 'superseded' | 'rejected';
    signal:
      | 'user_confirmed'
      | 'repeated_in_session'
      | 'contradicted'
      | 'corrected_by_user'
      | 'time_expired'
      | 'reactivated'
      | 'garbage_collected';
    provider: 'postgres' | 'mem0' | 'sqlite';
    at: string;
  };
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
  'master.updated': {
    userId: string;
    workspaceId: string;
    resources: MasterInvalidationResource[];
    runId?: string | null;
    approvalRequestId?: string | null;
    sessionId?: string | null;
    reminderId?: string | null;
    at: string;
  };
}

export type ServerEventName = keyof ServerEventMap;
