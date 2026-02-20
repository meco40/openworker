import { parseTelegramTarget } from '../telegram/targets';

const TELEGRAM_MAX_LENGTH = 4096;
const TELEGRAM_MAX_CALLBACK_DATA_BYTES = 64;
const TELEGRAM_API_MAX_ATTEMPTS = 3;
const TELEGRAM_API_BASE_BACKOFF_MS = 250;

export interface TelegramInlineKeyboardButton {
  text: string;
  callback_data: string;
}

export interface TelegramReplyMarkup {
  inline_keyboard: TelegramInlineKeyboardButton[][];
}

export interface TelegramTextOptions {
  replyMarkup?: TelegramReplyMarkup;
  parseMode?: 'HTML' | 'MarkdownV2';
  disableWebPagePreview?: boolean;
}

export function formatTelegramText(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\u0000/g, '');
}

export function splitTelegramMessage(text: string, maxLen = TELEGRAM_MAX_LENGTH): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    const candidate = remaining.slice(0, maxLen);
    let splitAt = candidate.lastIndexOf('\n');
    if (splitAt <= 0) splitAt = candidate.lastIndexOf(' ');
    if (splitAt <= 0) splitAt = maxLen;

    const chunk = remaining.slice(0, splitAt);
    chunks.push(chunk);

    remaining = remaining.slice(splitAt).replace(/^\n/, '');
  }

  return chunks;
}

export function buildInlineKeyboard(
  rows: Array<Array<{ text: string; callback_data: string }>>,
): TelegramReplyMarkup | undefined {
  const normalized: TelegramInlineKeyboardButton[][] = [];

  for (const row of rows) {
    const cleaned = row
      .map((button) => ({
        text: button.text?.trim() || '',
        callback_data: button.callback_data?.trim() || '',
      }))
      .filter(
        (button) =>
          button.text.length > 0 &&
          button.callback_data.length > 0 &&
          Buffer.byteLength(button.callback_data, 'utf8') <= TELEGRAM_MAX_CALLBACK_DATA_BYTES,
      );

    if (cleaned.length > 0) {
      normalized.push(cleaned);
    }
  }

  if (normalized.length === 0) {
    return undefined;
  }

  return { inline_keyboard: normalized };
}

async function resolveTelegramToken(explicitToken?: string): Promise<string | null> {
  if (explicitToken?.trim()) {
    return explicitToken.trim();
  }

  const { getCredentialStore } = await import('../credentials');
  return (
    getCredentialStore().getCredential('telegram', 'bot_token') ||
    process.env.TELEGRAM_BOT_TOKEN ||
    null
  );
}

async function postTelegramApi(
  method: string,
  payload: Record<string, unknown>,
  explicitToken?: string,
): Promise<Response | null> {
  const token = await resolveTelegramToken(explicitToken);
  if (!token) {
    console.error('Telegram bot token not configured (neither in credential store nor env).');
    return null;
  }

  let lastResponse: Response | null = null;
  for (let attempt = 1; attempt <= TELEGRAM_API_MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      lastResponse = response;
      if (response.ok) {
        return response;
      }

      if (!isRetryableTelegramStatus(response.status) || attempt >= TELEGRAM_API_MAX_ATTEMPTS) {
        return response;
      }
    } catch (error) {
      if (attempt >= TELEGRAM_API_MAX_ATTEMPTS) {
        throw error;
      }
    }

    await delay(TELEGRAM_API_BASE_BACKOFF_MS * 2 ** (attempt - 1));
  }

  return lastResponse;
}

export async function deliverTelegram(
  target: string,
  text: string,
  options: TelegramTextOptions = {},
): Promise<void> {
  const parsedTarget = parseTelegramTarget(target);
  const chatId = parsedTarget.chatId;
  const normalizedThreadId =
    typeof parsedTarget.messageThreadId === 'number' && Number.isFinite(parsedTarget.messageThreadId)
      ? Math.trunc(parsedTarget.messageThreadId)
      : undefined;
  const messageThreadId =
    parsedTarget.chatType === 'group' && normalizedThreadId === 1 ? undefined : normalizedThreadId;

  const formatted = formatTelegramText(text);
  const chunks = splitTelegramMessage(formatted);

  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const response = await postTelegramApi('sendMessage', {
      chat_id: chatId,
      text: chunk,
      ...(options.parseMode ? { parse_mode: options.parseMode } : {}),
      ...(options.disableWebPagePreview === false
        ? {}
        : { disable_web_page_preview: true }),
      ...(index === 0 && options.replyMarkup ? { reply_markup: options.replyMarkup } : {}),
      ...(typeof messageThreadId === 'number' && messageThreadId > 0
        ? { message_thread_id: messageThreadId }
        : {}),
    });

    if (!response) {
      return;
    }
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(`Telegram delivery failed: ${JSON.stringify(error)}`);
    }
  }
}

export async function editTelegramMessage(
  target: string,
  messageId: number,
  text: string,
  options: TelegramTextOptions = {},
): Promise<void> {
  const parsedTarget = parseTelegramTarget(target);
  const chatId = parsedTarget.chatId;
  const normalizedThreadId =
    typeof parsedTarget.messageThreadId === 'number' && Number.isFinite(parsedTarget.messageThreadId)
      ? Math.trunc(parsedTarget.messageThreadId)
      : undefined;
  const messageThreadId =
    parsedTarget.chatType === 'group' && normalizedThreadId === 1 ? undefined : normalizedThreadId;

  const response = await postTelegramApi('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text: formatTelegramText(text),
    ...(options.parseMode ? { parse_mode: options.parseMode } : {}),
    ...(options.disableWebPagePreview === false ? {} : { disable_web_page_preview: true }),
    ...(options.replyMarkup ? { reply_markup: options.replyMarkup } : {}),
    ...(typeof messageThreadId === 'number' && messageThreadId > 0
      ? { message_thread_id: messageThreadId }
      : {}),
  });

  if (!response) {
    return;
  }
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(`Telegram edit failed: ${JSON.stringify(error)}`);
  }
}

export async function answerTelegramCallbackQuery(
  callbackQueryId: string,
  text?: string,
  options?: { showAlert?: boolean },
): Promise<void> {
  const response = await postTelegramApi('answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    ...(text ? { text } : {}),
    ...(options?.showAlert ? { show_alert: true } : {}),
  });

  if (!response) {
    return;
  }
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    console.warn('Telegram callback answer failed:', error);
  }
}

function isRetryableTelegramStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
