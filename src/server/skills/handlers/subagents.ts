import { ChannelType } from '../../../../types';
import type { SkillDispatchContext } from '../executeSkill';

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

  const { getMessageService } = await import('../../channels/messages/runtime');
  const service = getMessageService();
  return service.invokeSubagentToolCall({
    args,
    conversationId,
    userId,
    platform,
    externalChatId,
  });
}
