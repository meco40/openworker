import type { Conversation } from '@/shared/domain/types';
import type { StoredMessage } from '@/server/channels/messages/repository';

export type MasterInvalidationResource =
  | 'runs'
  | 'run_detail'
  | 'metrics'
  | 'approvals'
  | 'subagents'
  | 'reminders'
  | 'settings';

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
