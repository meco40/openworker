import type { ChannelType } from '@/shared/domain/types';
import type { Conversation, StoredMessage } from '@/server/channels/messages/repository';
import type { SubagentManager } from '../subagentManager';
import type { ToolManager } from '../toolManager';
import type { HistoryManager } from '@/server/channels/messages/historyManager';

export interface CommandHandlerDeps {
  subagentManager: SubagentManager;
  toolManager: ToolManager;
  historyManager: HistoryManager;
  resolveWorkspaceCwd?: (conversation: Conversation) => string | undefined;
  sendResponse: (
    conversation: Conversation,
    content: string,
    platform: ChannelType,
    externalChatId: string,
    metadata?: Record<string, unknown>,
  ) => Promise<StoredMessage>;
  startSubagentRun: (params: {
    conversation: Conversation;
    platform: ChannelType;
    externalChatId: string;
    agentId: string;
    task: string;
    guidance?: string;
    modelOverride?: string;
  }) => Promise<import('@/server/agents/subagentRegistry').SubagentRunRecord>;
  runSubagent: (params: {
    conversation: Conversation;
    platform: ChannelType;
    externalChatId: string;
    run: import('@/server/agents/subagentRegistry').SubagentRunRecord;
  }) => Promise<void>;
}

// Re-export SubagentDispatchContext for convenience
export type { SubagentDispatchContext } from '../types';
