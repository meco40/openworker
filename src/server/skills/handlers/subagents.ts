import { ChannelType } from '../../../../types';
import type { SkillDispatchContext } from '../types';

export async function subagentsHandler(
  args: Record<string, unknown>,
  context?: SkillDispatchContext,
): Promise<unknown> {
  const conversationId = String(context?.conversationId || '').trim();
  const userId = String(context?.userId || '').trim();
  if (!conversationId || !userId) {
    return {
      status: 'error',
      error: 'subagents requires conversation context.',
    };
  }

  const platform =
    typeof context?.platform === 'string' && context.platform.trim()
      ? (context.platform as ChannelType)
      : ChannelType.WEBCHAT;
  const externalChatId =
    typeof context?.externalChatId === 'string' && context.externalChatId.trim()
      ? context.externalChatId
      : 'default';

  if (!context?.invokeSubagentToolCall) {
    return {
      status: 'error',
      error: 'subagents handler unavailable in current runtime context.',
    };
  }

  return context.invokeSubagentToolCall({
    args,
    conversationId,
    userId,
    platform,
    externalChatId,
  });
}
