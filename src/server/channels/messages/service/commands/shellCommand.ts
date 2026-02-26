import type { ChannelType } from '@/shared/domain/types';
import type { Conversation, StoredMessage } from '@/server/channels/messages/repository';
import type { CommandHandlerDeps } from './types';

export async function handleShellCommand(
  conversation: Conversation,
  payload: string,
  platform: ChannelType,
  externalChatId: string,
  deps: CommandHandlerDeps,
): Promise<StoredMessage> {
  const command = String(payload || '').trim();
  if (!command) {
    return deps.sendResponse(
      conversation,
      'Bitte nutze /shell <command> oder !<command>.',
      platform,
      externalChatId,
    );
  }

  const toolContext = await deps.toolManager.resolveToolContext();

  const toolExecution = await deps.toolManager.executeToolFunctionCall({
    conversation,
    platform,
    externalChatId,
    functionName: 'shell_execute',
    args: { command },
    workspaceCwd: deps.resolveWorkspaceCwd?.(conversation),
    installedFunctions: toolContext.installedFunctionNames,
    toolId: toolContext.functionToSkillId.get('shell_execute') || 'shell-access',
  });

  if (toolExecution.kind === 'approval_required') {
    return deps.sendResponse(
      conversation,
      toolExecution.prompt,
      platform,
      externalChatId,
      deps.toolManager.buildApprovalMetadata(toolExecution.pending, toolExecution.prompt, {
        ok: false,
        runtime: 'chat-shell-command',
      }),
    );
  }

  const message =
    toolExecution.kind === 'ok'
      ? `CLI command completed:\n${toolExecution.output}`
      : `CLI command failed:\n${toolExecution.output}`;

  return deps.sendResponse(conversation, message, platform, externalChatId, {
    ok: toolExecution.kind === 'ok',
    runtime: 'chat-shell-command',
    tool: 'shell_execute',
    command,
  });
}
