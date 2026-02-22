import { ChannelType } from '@/shared/domain/types';
import { getMessageService } from '@/server/channels/messages/runtime';
import { answerTelegramCallbackQuery, deliverTelegram } from '@/server/channels/outbound/telegram';
import {
  ensureTelegramPairingCode,
  isTelegramChatAuthorized,
} from '@/server/channels/pairing/telegramCodePairing';
import {
  handleTelegramNativeCommand,
  processTelegramModelCallback,
  type TelegramModelCallbackQuery,
} from '@/server/channels/telegram/modelSelection';
import { applyTelegramGroupMigration } from '@/server/channels/telegram/groupMigration';
import {
  extractTelegramInboundMedia,
  resolveTelegramInboundText,
} from '@/server/channels/telegram/media';

export interface TelegramInboundMessage {
  message_id: number;
  from?: { id: number; first_name?: string; username?: string };
  chat: { id: number; type: string; is_forum?: boolean };
  text?: string;
  caption?: string;
  message_thread_id?: number;
  migrate_to_chat_id?: number;
  migrate_from_chat_id?: number;
  photo?: Array<{ file_id: string; width?: number; height?: number; file_size?: number }>;
  document?: {
    file_id: string;
    file_name?: string;
    mime_type?: string;
    file_size?: number;
  };
  audio?: {
    file_id: string;
    file_name?: string;
    mime_type?: string;
    file_size?: number;
    duration?: number;
    title?: string;
    performer?: string;
  };
  voice?: {
    file_id: string;
    mime_type?: string;
    file_size?: number;
    duration?: number;
  };
  video?: {
    file_id: string;
    file_name?: string;
    mime_type?: string;
    file_size?: number;
    duration?: number;
  };
  animation?: {
    file_id: string;
    file_name?: string;
    mime_type?: string;
    file_size?: number;
    duration?: number;
  };
  sticker?: {
    file_id: string;
    file_unique_id?: string;
    emoji?: string;
    set_name?: string;
    is_animated?: boolean;
    is_video?: boolean;
  };
}

export interface TelegramInboundProcessResult {
  handled: boolean;
  codeIssued: boolean;
}

/**
 * Context injected when a message arrives via a persona-bound Telegram bot.
 * When present, code-pairing is skipped and the personaId is forced.
 */
export interface TelegramBotContext {
  botId: string;
  personaId: string;
  token: string;
}

export interface TelegramInboundUpdate {
  message?: TelegramInboundMessage;
  callback_query?: TelegramModelCallbackQuery;
}

export async function processTelegramInboundMessage(
  message: TelegramInboundMessage,
  botContext?: TelegramBotContext,
): Promise<TelegramInboundProcessResult> {
  const migration = applyTelegramGroupMigration(message);
  if (migration.migrated) {
    console.log(
      '[Telegram] Group migration applied: %s -> %s',
      migration.oldChatId,
      migration.newChatId,
    );
  }

  const chatId = String(message.chat.id);
  const externalChatId = resolveTelegramConversationExternalChatId(message);
  const senderName =
    message.from?.username || message.from?.first_name || `user-${message.from?.id}`;
  const externalMsgId = String(message.message_id);

  // Persona-bound bots bypass code-pairing — all chats are trusted
  if (!botContext && !isTelegramChatAuthorized(chatId)) {
    const pairingResult = ensureTelegramPairingCode(chatId);
    if (pairingResult.kind === 'issued') {
      const expiration = new Date(pairingResult.expiresAt).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      });
      await deliverTelegram(
        chatId,
        `Pairing code: ${pairingResult.code}\nEnter this in the Web UI before ${expiration}.`,
      );
      return { handled: false, codeIssued: true };
    }

    if (pairingResult.kind === 'blocked') {
      await deliverTelegram(
        chatId,
        'Pairing is already pending in another chat. Complete the code entry in the Web UI first.',
      );
      return { handled: false, codeIssued: false };
    }

    if (pairingResult.kind === 'already_bound') {
      await deliverTelegram(
        chatId,
        'This bot is already paired with another chat. Re-run pairing from the Web UI to switch chats.',
      );
      return { handled: false, codeIssued: false };
    }

    return { handled: false, codeIssued: false };
  }

  const commandText = message.text?.trim();
  if (commandText && (await handleTelegramNativeCommand(chatId, commandText, externalChatId))) {
    return { handled: true, codeIssued: false };
  }

  const service = getMessageService();
  const conversation = service.getOrCreateConversation(ChannelType.TELEGRAM, externalChatId);

  // Force personaId from bot context when the conversation has none yet
  if (botContext?.personaId && !conversation.personaId) {
    service.setPersonaId(conversation.id, botContext.personaId, conversation.userId);
  }
  const effectivePersonaId = botContext?.personaId || conversation.personaId || null;
  const personaSlug = effectivePersonaId
    ? (await import('@/server/personas/personaRepository'))
        .getPersonaRepository()
        .getPersona(effectivePersonaId)?.slug || null
    : null;

  // Use persona bot token for media extraction, fall back to global credential
  const resolvedToken =
    botContext?.token ??
    process.env.TELEGRAM_BOT_TOKEN ??
    (await import('@/server/channels/credentials'))
      .getCredentialStore()
      .getCredential('telegram', 'bot_token');

  const media = await extractTelegramInboundMedia({
    message,
    userId: conversation.userId,
    conversationId: conversation.id,
    personaSlug,
    botToken: resolvedToken,
  });
  const content = resolveTelegramInboundText(message, media.summaryText);
  if (!content) {
    return { handled: false, codeIssued: false };
  }

  await service.handleInbound(
    ChannelType.TELEGRAM,
    externalChatId,
    content,
    senderName,
    externalMsgId,
    undefined,
    undefined,
    media.attachments,
  );
  return { handled: true, codeIssued: false };
}

export async function processTelegramInboundUpdate(
  update: TelegramInboundUpdate,
  botContext?: TelegramBotContext,
): Promise<TelegramInboundProcessResult> {
  if (update.callback_query) {
    // Persona-bound bots: skip pairing guard for callbacks too
    const callbackChatId = update.callback_query.message?.chat?.id;
    if (
      !botContext &&
      typeof callbackChatId === 'number' &&
      !isTelegramChatAuthorized(String(callbackChatId))
    ) {
      await answerTelegramCallbackQuery(update.callback_query.id, 'Pairing required.');
      return { handled: true, codeIssued: false };
    }

    const handled = await processTelegramModelCallback(update.callback_query);
    return { handled, codeIssued: false };
  }

  if (update.message) {
    return processTelegramInboundMessage(update.message, botContext);
  }

  return { handled: false, codeIssued: false };
}

function resolveTelegramConversationExternalChatId(message: TelegramInboundMessage): string {
  const baseChatId = String(message.chat.id);
  const threadId =
    typeof message.message_thread_id === 'number' && Number.isFinite(message.message_thread_id)
      ? Math.trunc(message.message_thread_id)
      : null;

  if (threadId === null || threadId <= 0) {
    return baseChatId;
  }

  if (message.chat.type === 'private') {
    return `${baseChatId}:topic:${threadId}`;
  }

  const isForumGroup = message.chat.type === 'supergroup' && message.chat.is_forum === true;
  if (!isForumGroup) {
    return baseChatId;
  }

  // Telegram forum "General topic" has id=1 and should route to base group session.
  if (threadId === 1) {
    return baseChatId;
  }

  return `${baseChatId}:topic:${threadId}`;
}
