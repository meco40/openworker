import type { InboundEnvelope } from './envelope';

interface TelegramInboundPayload {
  update_id?: number;
  message?: {
    message_id?: number;
    from?: { id?: number; first_name?: string; username?: string };
    chat?: { id?: number; type?: string };
    text?: string;
  };
}

interface DiscordInboundPayload {
  channel_id?: string;
  content?: string;
  author?: { id?: string; username?: string };
  id?: string;
}

interface WhatsAppInboundPayload {
  from?: string;
  chatId?: string;
  body?: string;
  messageId?: string;
  senderName?: string;
}

interface IMessageInboundPayload {
  chatGuid?: string;
  text?: string;
  senderName?: string;
  messageId?: string;
}

function normalizeText(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function makeEnvelope(
  channel: InboundEnvelope['channel'],
  externalChatId: string,
  content: string,
  raw: unknown,
  senderName: string | null = null,
  externalMessageId: string | null = null,
): InboundEnvelope {
  return {
    channel,
    externalChatId,
    externalMessageId,
    senderName,
    content,
    receivedAt: new Date().toISOString(),
    raw,
  };
}

export function normalizeTelegramInbound(payload: TelegramInboundPayload): InboundEnvelope | null {
  const content = normalizeText(payload.message?.text);
  const chatId = payload.message?.chat?.id;
  if (!content || typeof chatId !== 'number') {
    return null;
  }
  const senderName = payload.message?.from?.username || payload.message?.from?.first_name || null;
  const messageId = payload.message?.message_id;
  return makeEnvelope(
    'telegram',
    String(chatId),
    content,
    payload,
    senderName,
    typeof messageId === 'number' ? String(messageId) : null,
  );
}

export function normalizeDiscordInbound(payload: DiscordInboundPayload): InboundEnvelope | null {
  const content = normalizeText(payload.content);
  const chatId = payload.channel_id?.trim();
  if (!content || !chatId) {
    return null;
  }
  return makeEnvelope(
    'discord',
    chatId,
    content,
    payload,
    payload.author?.username || null,
    payload.id?.trim() || null,
  );
}

export function normalizeWhatsAppInbound(payload: WhatsAppInboundPayload): InboundEnvelope | null {
  const content = normalizeText(payload.body);
  const chatId = payload.chatId?.trim() || payload.from?.trim();
  if (!content || !chatId) {
    return null;
  }
  return makeEnvelope(
    'whatsapp',
    chatId,
    content,
    payload,
    payload.senderName || payload.from || null,
    payload.messageId?.trim() || null,
  );
}

export function normalizeIMessageInbound(payload: IMessageInboundPayload): InboundEnvelope | null {
  const content = normalizeText(payload.text);
  const chatId = payload.chatGuid?.trim();
  if (!content || !chatId) {
    return null;
  }
  return makeEnvelope(
    'imessage',
    chatId,
    content,
    payload,
    payload.senderName || 'iMessage User',
    payload.messageId?.trim() || null,
  );
}
