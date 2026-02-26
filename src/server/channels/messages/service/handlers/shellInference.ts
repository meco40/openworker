/**
 * Shell inference handler
 * Extracted from the monolithic index.ts
 */

import type { Conversation, StoredMessage } from '@/server/channels/messages/repository';
import type { ChannelType } from '@/shared/domain/types';
import type { ToolManager } from '@/server/channels/messages/service/toolManager';
import type { ContextBuilder } from '@/server/channels/messages/contextBuilder';
import { runModelToolLoop } from '@/server/channels/messages/service/dispatchers/aiDispatcher';
import type { ModelRoutingConfig } from '../routing/modelRouting';

/**
 * Dependencies for shell inference
 */
export interface ShellInferenceDeps {
  contextBuilder: ContextBuilder;
  toolManager: ToolManager;
  resolveChatModelRouting: (conversation: Conversation) => ModelRoutingConfig;
  resolveConversationWorkspaceCwd: (conversation: Conversation) => string | undefined;
}

/**
 * Handle an inferred shell question
 */
export async function handleInferredShellQuestion(
  deps: ShellInferenceDeps,
  sendResponse: (
    conversation: Conversation,
    content: string,
    platform: ChannelType,
    externalChatId: string,
    metadata?: Record<string, unknown>,
  ) => Promise<StoredMessage>,
  params: {
    conversation: Conversation;
    platform: ChannelType;
    externalChatId: string;
    userInput: string;
    command: string;
    onStreamDelta?: (delta: string) => void;
  },
): Promise<StoredMessage> {
  const { conversation, platform, externalChatId, userInput, command, onStreamDelta } = params;
  const workspaceCwd = deps.resolveConversationWorkspaceCwd(conversation);
  const toolContext = await deps.toolManager.resolveToolContext();

  const toolExecution = await deps.toolManager.executeToolFunctionCall({
    conversation,
    platform,
    externalChatId,
    functionName: 'shell_execute',
    args: { command },
    workspaceCwd,
    installedFunctions: toolContext.installedFunctionNames,
    toolId: toolContext.functionToSkillId.get('shell_execute') || 'shell-access',
  });

  if (toolExecution.kind === 'approval_required') {
    return sendResponse(
      conversation,
      toolExecution.prompt,
      platform,
      externalChatId,
      deps.toolManager.buildApprovalMetadata(toolExecution.pending, toolExecution.prompt, {
        ok: false,
        runtime: 'chat-shell-inference',
        inferredCommand: command,
        inferredFrom: userInput,
      }),
    );
  }

  const toolResultContent =
    toolExecution.kind === 'ok'
      ? `Tool "shell_execute" result:\n${toolExecution.output}`
      : `Tool "shell_execute" failed:\n${toolExecution.output}`;

  const messages = deps.contextBuilder.buildGatewayMessages(
    conversation.id,
    conversation.userId,
    50,
    conversation.personaId,
  );
  messages.push({ role: 'assistant', content: '[Tool call: shell_execute]' });
  messages.push({ role: 'user', content: toolResultContent });

  const { preferredModelId, modelHubProfileId } = deps.resolveChatModelRouting(conversation);
  const modelOutcome = await runModelToolLoop(deps.toolManager, {
    conversation,
    messages,
    modelHubProfileId,
    preferredModelId,
    workspaceCwd,
    toolContext,
    onStreamDelta,
  });

  return sendResponse(conversation, modelOutcome.content, platform, externalChatId, {
    ...modelOutcome.metadata,
    runtime: 'chat-shell-inference',
    inferredCommand: command,
  });
}
