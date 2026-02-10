import { ChannelType } from '../../../../types';
import { getMessageService } from '../messages/runtime';
import { deliverTelegram } from '../outbound/telegram';
import {
  ensureTelegramPairingCode,
  isTelegramChatAuthorized,
} from './telegramCodePairing';

export interface TelegramInboundMessage {
  message_id: number;
  from?: { id: number; first_name?: string; username?: string };
  chat: { id: number; type: string };
  text?: string;
}

export interface TelegramInboundProcessResult {
  handled: boolean;
  codeIssued: boolean;
}

export async function processTelegramInboundMessage(
  message: TelegramInboundMessage,
): Promise<TelegramInboundProcessResult> {
  if (!message.text) {
    return { handled: false, codeIssued: false };
  }

  const chatId = String(message.chat.id);
  const text = message.text;
  const senderName =
    message.from?.username ||
    message.from?.first_name ||
    `user-${message.from?.id}`;
  const externalMsgId = String(message.message_id);

  if (!isTelegramChatAuthorized(chatId)) {
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

  const service = getMessageService();
  await service.handleInbound(ChannelType.TELEGRAM, chatId, text, senderName, externalMsgId);
  return { handled: true, codeIssued: false };
}
