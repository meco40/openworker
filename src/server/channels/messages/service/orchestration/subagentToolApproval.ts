import type { ChannelType } from '@/shared/domain/types';
import type { Conversation, StoredMessage } from '@/server/channels/messages/repository';
import type { SessionManager } from '@/server/channels/messages/sessionManager';
import type { ContextBuilder } from '@/server/channels/messages/contextBuilder';
import type { SubagentManager } from '@/server/channels/messages/service/subagentManager';
import type { ToolManager } from '@/server/channels/messages/service/toolManager';
import type { SummaryService } from '@/server/channels/messages/service/summaryService';
import type { HistoryManager } from '@/server/channels/messages/historyManager';
import {
  runSubagent,
  invokeSubagentToolCall,
} from '@/server/channels/messages/service/execution/subagentExecution';
import { respondToolApproval } from '@/server/channels/messages/service/execution/toolApproval';
import type { CommandHandlerDeps } from '@/server/channels/messages/service/commands';
import type { ModelRoutingConfig } from '@/server/channels/messages/service/routing/modelRouting';

export interface SubagentToolApprovalDeps {
  sessionManager: SessionManager;
  contextBuilder: ContextBuilder;
  subagentManager: SubagentManager;
  toolManager: ToolManager;
  summaryService: SummaryService;
  historyManager: HistoryManager;
  sendResponse: (
    conversation: Conversation,
    content: string,
    platform: ChannelType,
    externalChatId: string,
    metadata?: Record<string, unknown>,
  ) => Promise<StoredMessage>;
  resolveChatModelRouting: (conversation: Conversation) => ModelRoutingConfig;
  resolveConversationWorkspaceCwd: (conversation: Conversation) => string | undefined;
  getConversation: (conversationId: string, userId?: string) => Conversation | null;
  setConversationProjectGuardApproved: (
    conversationId: string,
    userId: string,
    approved: boolean,
  ) => void;
}

export function buildCommandHandlerDeps(
  deps: Pick<
    SubagentToolApprovalDeps,
    | 'subagentManager'
    | 'toolManager'
    | 'historyManager'
    | 'resolveConversationWorkspaceCwd'
    | 'sendResponse'
  >,
  runSubagentImpl: (params: {
    conversation: Conversation;
    platform: ChannelType;
    externalChatId: string;
    run: import('@/server/agents/subagentRegistry').SubagentRunRecord;
  }) => Promise<void>,
): CommandHandlerDeps {
  return {
    subagentManager: deps.subagentManager,
    toolManager: deps.toolManager,
    historyManager: deps.historyManager,
    resolveWorkspaceCwd: (conversation) => deps.resolveConversationWorkspaceCwd(conversation),
    sendResponse: deps.sendResponse,
    startSubagentRun: async (params) => deps.subagentManager.startSubagentRun(params),
    runSubagent: runSubagentImpl,
  };
}

export async function runSubagentOperation(
  deps: Pick<
    SubagentToolApprovalDeps,
    'subagentManager' | 'toolManager' | 'resolveChatModelRouting' | 'sendResponse'
  >,
  params: {
    conversation: Conversation;
    platform: ChannelType;
    externalChatId: string;
    run: import('@/server/agents/subagentRegistry').SubagentRunRecord;
  },
): Promise<void> {
  return runSubagent(
    {
      subagentManager: deps.subagentManager,
      toolManager: deps.toolManager,
      resolveChatModelRouting: deps.resolveChatModelRouting,
    },
    deps.sendResponse,
    params,
  );
}

export async function invokeSubagentToolCallOperation(
  deps: Pick<
    SubagentToolApprovalDeps,
    'subagentManager' | 'toolManager' | 'resolveChatModelRouting' | 'getConversation'
  >,
  getCommandHandlerDeps: () => CommandHandlerDeps,
  params: {
    args: Record<string, unknown>;
    conversationId: string;
    userId: string;
    platform: ChannelType;
    externalChatId: string;
  },
): Promise<Record<string, unknown>> {
  return invokeSubagentToolCall(
    {
      subagentManager: deps.subagentManager,
      toolManager: deps.toolManager,
      resolveChatModelRouting: deps.resolveChatModelRouting,
      getConversation: deps.getConversation,
      getCommandHandlerDeps,
    },
    params,
  );
}

export async function respondToolApprovalOperation(
  deps: Pick<
    SubagentToolApprovalDeps,
    | 'sessionManager'
    | 'contextBuilder'
    | 'toolManager'
    | 'summaryService'
    | 'getConversation'
    | 'setConversationProjectGuardApproved'
    | 'resolveConversationWorkspaceCwd'
    | 'resolveChatModelRouting'
    | 'sendResponse'
  >,
  params: {
    conversationId: string;
    userId: string;
    approvalToken: string;
    approved: boolean;
    approveAlways?: boolean;
    toolId?: string;
    toolFunctionName?: string;
  },
): Promise<{
  ok: boolean;
  status: 'approved' | 'denied' | 'not_found' | 'approval_required';
  policyUpdated: boolean;
}> {
  return respondToolApproval(
    {
      sessionManager: deps.sessionManager,
      contextBuilder: deps.contextBuilder,
      toolManager: deps.toolManager,
      summaryService: deps.summaryService,
      getConversation: deps.getConversation,
      setConversationProjectGuardApproved: deps.setConversationProjectGuardApproved,
      resolveConversationWorkspaceCwd: deps.resolveConversationWorkspaceCwd,
      resolveChatModelRouting: deps.resolveChatModelRouting,
    },
    deps.sendResponse,
    params,
  );
}
