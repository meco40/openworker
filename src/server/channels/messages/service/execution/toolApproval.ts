/**
 * Tool approval utilities
 * Extracted from the monolithic index.ts
 */

import type { Conversation } from '@/server/channels/messages/repository';
import type { SessionManager } from '@/server/channels/messages/sessionManager';
import type { ContextBuilder } from '@/server/channels/messages/contextBuilder';
import type { ToolManager } from '@/server/channels/messages/service/toolManager';
import type { SummaryService } from '@/server/channels/messages/service/summaryService';
import { runModelToolLoop } from '@/server/channels/messages/service/dispatchers/aiDispatcher';
import { respondToolApproval as execRespondToolApproval } from '@/server/channels/messages/service/approval/handler';
import type { ModelRoutingConfig } from '../routing/modelRouting';

/**
 * Dependencies for tool approval
 */
export interface ToolApprovalDeps {
  sessionManager: SessionManager;
  contextBuilder: ContextBuilder;
  toolManager: ToolManager;
  summaryService: SummaryService;
  getConversation: (conversationId: string, userId?: string) => Conversation | null;
  setConversationProjectGuardApproved: (
    conversationId: string,
    userId: string,
    approved: boolean,
  ) => void;
  resolveConversationWorkspaceCwd: (conversation: Conversation) => string | undefined;
  resolveChatModelRouting: (conversation: Conversation) => ModelRoutingConfig;
}

/**
 * Tool approval result
 */
export interface ToolApprovalResult {
  ok: boolean;
  status: 'approved' | 'denied' | 'not_found' | 'approval_required';
  policyUpdated: boolean;
}

/**
 * Respond to a tool approval request
 */
export async function respondToolApproval(
  deps: ToolApprovalDeps,
  sendResponse: (
    conversation: Conversation,
    content: string,
    platform: import('@/shared/domain/types').ChannelType,
    externalChatId: string,
    metadata?: Record<string, unknown>,
  ) => Promise<import('@/server/channels/messages/repository').StoredMessage>,
  params: {
    conversationId: string;
    userId: string;
    approvalToken: string;
    approved: boolean;
    approveAlways?: boolean;
    toolId?: string;
    toolFunctionName?: string;
  },
): Promise<ToolApprovalResult> {
  return execRespondToolApproval(
    {
      sessionManager: deps.sessionManager,
      contextBuilder: deps.contextBuilder,
      toolManager: deps.toolManager,
      summaryService: deps.summaryService,
      getConversation: deps.getConversation,
      setConversationProjectGuardApproved: deps.setConversationProjectGuardApproved,
      resolveConversationWorkspaceCwd: deps.resolveConversationWorkspaceCwd,
      resolveChatModelRouting: deps.resolveChatModelRouting,
      runModelToolLoop,
    },
    sendResponse,
    params,
  );
}
