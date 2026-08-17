import { ChannelType } from '@/shared/domain/types';
import { getMessageService } from '@/server/channels/messages/runtime';
import { deleteMessageWithSideEffects } from '@/server/channels/messages/deleteMessageAction';
import { deliverTelegram } from '@/server/channels/outbound/telegram';
import { handleTelegramModelCommand } from '@/server/channels/telegram/modelSelection';

export type ParsedTelegramNativeCommand =
  | { kind: 'none' }
  | { kind: 'model'; args: string; command: '/model' }
  | { kind: 'chatdelete'; args: string; command: '/chatdelete' };

function resolveReplyTarget(chatId: string, conversationExternalChatId?: string): string {
  return conversationExternalChatId || chatId;
}

export function parseTelegramNativeCommand(text: string): ParsedTelegramNativeCommand {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) {
    return { kind: 'none' };
  }

  const firstSpace = trimmed.indexOf(' ');
  const token = (firstSpace >= 0 ? trimmed.slice(0, firstSpace) : trimmed).toLowerCase();
  const bareToken = token.split('@')[0];
  const args = firstSpace >= 0 ? trimmed.slice(firstSpace + 1).trim() : '';

  if (bareToken === '/model') {
    return { kind: 'model', args, command: '/model' };
  }

  if (bareToken === '/chatdelete') {
    return { kind: 'chatdelete', args, command: '/chatdelete' };
  }

  return { kind: 'none' };
}

async function handleTelegramDeleteCommand(
  chatId: string,
  conversationExternalChatId?: string,
): Promise<void> {
  const service = getMessageService();
  const externalChatId = conversationExternalChatId || chatId;
  const replyTarget = resolveReplyTarget(chatId, conversationExternalChatId);
  const conversation = service.getConversationByExternalChat(ChannelType.TELEGRAM, externalChatId);

  if (!conversation) {
    await deliverTelegram(replyTarget, 'Nothing to delete.');
    return;
  }

  const latestMessage =
    service.listMessages(conversation.id, conversation.userId, 1).at(-1) || null;
  if (!latestMessage) {
    await deliverTelegram(replyTarget, 'Nothing to delete.');
    return;
  }

  const result = await deleteMessageWithSideEffects({
    service,
    messageId: latestMessage.id,
    userId: conversation.userId,
    conversationId: conversation.id,
  });

  if (!result.ok) {
    await deliverTelegram(replyTarget, 'Nothing to delete.');
    return;
  }

  await deliverTelegram(replyTarget, 'Last message deleted.');
}

export async function handleTelegramNativeCommand(
  chatId: string,
  text: string,
  conversationExternalChatId?: string,
): Promise<boolean> {
  const parsed = parseTelegramNativeCommand(text);
  const replyTarget = resolveReplyTarget(chatId, conversationExternalChatId);

  if (parsed.kind === 'model') {
    await handleTelegramModelCommand(replyTarget, parsed.args, conversationExternalChatId);
    return true;
  }

  if (parsed.kind === 'chatdelete') {
    await handleTelegramDeleteCommand(chatId, conversationExternalChatId);
    return true;
  }

  return false;
}
