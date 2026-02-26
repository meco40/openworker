import type { StoredMessage } from '@/server/channels/messages/repository';
import type { SubagentDispatchContext } from '../types';
import type { CommandHandlerDeps } from './types';

export async function handleSubagentCommand(
  context: SubagentDispatchContext,
  payload: string,
  command: string | undefined,
  deps: CommandHandlerDeps,
): Promise<StoredMessage> {
  const parsed = deps.subagentManager.parseSubagentAction(payload, command);
  const result = await deps.subagentManager.executeSubagentAction(
    context,
    parsed.action,
    parsed.args,
    {
      startSubagentRun: deps.startSubagentRun,
      runSubagent: deps.runSubagent,
      sendResponse: deps.sendResponse,
    },
  );
  return deps.sendResponse(
    context.conversation,
    result.text,
    context.platform,
    context.externalChatId,
    {
      runtime: 'subagents-command',
      action: parsed.action,
      ...(result.payload || {}),
    },
  );
}
