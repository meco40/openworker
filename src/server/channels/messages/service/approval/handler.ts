import type { Conversation } from '@/server/channels/messages/repository';
import type { SessionManager } from '@/server/channels/messages/sessionManager';
import type { ContextBuilder } from '@/server/channels/messages/contextBuilder';
import type { ToolManager } from '@/server/channels/messages/service/toolManager';
import type { SummaryService } from '@/server/channels/messages/service/summaryService';

export interface ApprovalHandlerDeps {
  sessionManager: SessionManager;
  contextBuilder: ContextBuilder;
  toolManager: ToolManager;
  summaryService: SummaryService;
  getConversation: (conversationId: string, userId: string) => Conversation | null;
  resolveChatModelRouting: (conversation: Conversation) => {
    preferredModelId?: string;
    modelHubProfileId: string;
  };
  runModelToolLoop: (
    toolManager: ToolManager,
    params: {
      conversation: Conversation;
      messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
      modelHubProfileId: string;
      preferredModelId?: string;
      toolContext: { tools: unknown[]; installedFunctionNames: Set<string>; functionToSkillId: Map<string, string> };
      abortSignal?: AbortSignal;
      onStreamDelta?: (delta: string) => void;
    },
  ) => Promise<{ content: string; metadata: Record<string, unknown> }>;
}

export async function respondToolApproval(
  deps: ApprovalHandlerDeps,
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
): Promise<{
  ok: boolean;
  status: 'approved' | 'denied' | 'not_found' | 'approval_required';
  policyUpdated: boolean;
}> {
  deps.toolManager.prunePendingToolApprovals();

  const token = String(params.approvalToken || '').trim();
  if (!token) {
    return { ok: false, status: 'not_found', policyUpdated: false };
  }

  const pending = deps.toolManager.getPendingApproval(token);
  if (
    !pending ||
    pending.userId !== deps.sessionManager.resolveUserId(params.userId) ||
    pending.conversationId !== params.conversationId
  ) {
    return { ok: false, status: 'not_found', policyUpdated: false };
  }

  if (params.toolFunctionName && params.toolFunctionName !== pending.toolFunctionName) {
    return { ok: false, status: 'not_found', policyUpdated: false };
  }
  if (params.toolId && pending.toolId && params.toolId !== pending.toolId) {
    return { ok: false, status: 'not_found', policyUpdated: false };
  }

  deps.toolManager.deletePendingApproval(token);

  const conversation = deps.getConversation(pending.conversationId, pending.userId);
  if (!conversation) {
    return { ok: false, status: 'not_found', policyUpdated: false };
  }

  if (!params.approved) {
    await sendResponse(
      conversation,
      'Befehl wurde abgelehnt. Ich fuehre diesen Tool-Aufruf nicht aus.',
      pending.platform,
      pending.externalChatId,
    );
    return { ok: true, status: 'denied', policyUpdated: false };
  }

  let policyUpdated = false;
  if (params.approveAlways && pending.command) {
    await deps.toolManager.approveCommand(pending.command);
    policyUpdated = true;
  }

  const toolContext = await deps.toolManager.resolveToolContext();
  const toolExecution = await deps.toolManager.executeToolFunctionCall({
    conversation,
    platform: pending.platform,
    externalChatId: pending.externalChatId,
    functionName: pending.toolFunctionName,
    args: pending.args,
    installedFunctions: toolContext.installedFunctionNames,
    toolId: pending.toolId,
    skipApprovalCheck: true,
  });

  const toolResultContent =
    toolExecution.kind === 'ok'
      ? `Tool "${pending.toolFunctionName}" result:\n${toolExecution.output}`
      : `Tool "${pending.toolFunctionName}" failed:\n${
          toolExecution.kind === 'approval_required' ? 'Approval unresolved.' : toolExecution.output
        }`;

  const messages = deps.contextBuilder.buildGatewayMessages(
    conversation.id,
    conversation.userId,
    50,
    conversation.personaId,
  );
  messages.push({ role: 'assistant', content: `[Tool call: ${pending.toolFunctionName}]` });
  messages.push({ role: 'user', content: toolResultContent });

  const { preferredModelId, modelHubProfileId } = deps.resolveChatModelRouting(conversation);
  const modelOutcome = await deps.runModelToolLoop(deps.toolManager, {
    conversation,
    messages,
    modelHubProfileId,
    preferredModelId,
    toolContext,
  });

  await sendResponse(
    conversation,
    modelOutcome.content,
    pending.platform,
    pending.externalChatId,
    modelOutcome.metadata,
  );

  void deps.summaryService.maybeRefreshConversationSummary(conversation);
  const nextStatus =
    String(modelOutcome.metadata?.status || '').trim() === 'approval_required'
      ? 'approval_required'
      : 'approved';
  return { ok: true, status: nextStatus, policyUpdated };
}
