/**
 * Subagent execution utilities
 * Extracted from the monolithic index.ts
 */

import type { Conversation } from '@/server/channels/messages/repository';
import type { ChannelType } from '@/shared/domain/types';
import type { SubagentManager } from '@/server/channels/messages/service/subagentManager';
import type { ToolManager } from '@/server/channels/messages/service/toolManager';
import { runModelToolLoop } from '@/server/channels/messages/service/dispatchers/aiDispatcher';
import {
  runSubagent as execRunSubagent,
  invokeSubagentToolCall as execInvokeSubagentToolCall,
} from '@/server/channels/messages/service/subagent/executor';
import type { ModelRoutingConfig } from '../routing/modelRouting';
import type { CommandHandlerDeps } from '../core/types';

/**
 * Dependencies for subagent execution
 */
export interface SubagentExecutionDeps {
  subagentManager: SubagentManager;
  toolManager: ToolManager;
  resolveChatModelRouting: (conversation: Conversation) => ModelRoutingConfig;
}

/**
 * Run a subagent
 */
export async function runSubagent(
  deps: SubagentExecutionDeps,
  sendResponse: (
    conversation: Conversation,
    content: string,
    platform: ChannelType,
    externalChatId: string,
    metadata?: Record<string, unknown>,
  ) => Promise<import('@/server/channels/messages/repository').StoredMessage>,
  params: {
    conversation: Conversation;
    platform: ChannelType;
    externalChatId: string;
    run: import('@/server/agents/subagentRegistry').SubagentRunRecord;
  },
): Promise<void> {
  return execRunSubagent(
    {
      subagentManager: deps.subagentManager,
      toolManager: deps.toolManager,
      resolveChatModelRouting: deps.resolveChatModelRouting,
      runModelToolLoop,
    },
    sendResponse,
    params,
  );
}

/**
 * Invoke a subagent tool call
 */
export async function invokeSubagentToolCall(
  deps: SubagentExecutionDeps & {
    getConversation: (conversationId: string, userId?: string) => Conversation | null;
    getCommandHandlerDeps: () => CommandHandlerDeps;
  },
  params: {
    args: Record<string, unknown>;
    conversationId: string;
    userId: string;
    platform: ChannelType;
    externalChatId: string;
  },
): Promise<Record<string, unknown>> {
  return execInvokeSubagentToolCall(
    {
      subagentManager: deps.subagentManager,
      toolManager: deps.toolManager,
      resolveChatModelRouting: deps.resolveChatModelRouting,
      runModelToolLoop,
      getConversation: deps.getConversation,
      getCommandHandlerDeps: deps.getCommandHandlerDeps,
    },
    params,
  );
}
