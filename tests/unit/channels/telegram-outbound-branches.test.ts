import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  answerTelegramCallbackQuery,
  buildInlineKeyboard,
  deliverTelegram,
  editTelegramMessage,
  splitTelegramMessage,
} from '@/server/channels/outbound/telegram';

type FetchMock = ReturnType<typeof vi.fn> & {
  mock: {
    calls: Array<[string, RequestInit]>;
  };
};

function bodyOf(fetchMock: FetchMock, index = 0): Record<string, unknown> {
  const init = fetchMock.mock.calls[index]?.[1];
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

function urlOf(fetchMock: FetchMock, index = 0): string {
  return String(fetchMock.mock.calls[index]?.[0] ?? '');
}

vi.mock('@/server/channels/telegram/targets', () => ({
  parseTelegramTarget: vi.fn((target: string) => {
    if (target === 'group:1') {
      return { chatId: 'group-1', chatType: 'group', messageThreadId: 1 };
    }
    if (target === 'group:5') {
      return { chatId: 'group-5', chatType: 'group', messageThreadId: 5 };
    }
    return { chatId: 'chat-1', chatType: 'private', messageThreadId: undefined };
  }),
}));

describe('outbound/telegram branch coverage', () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.TELEGRAM_BOT_TOKEN;

  beforeEach(() => {
    vi.resetModules();
    globalThis.fetch = vi.fn();
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) {
      delete process.env.TELEGRAM_BOT_TOKEN;
    } else {
      process.env.TELEGRAM_BOT_TOKEN = originalToken;
    }
    vi.restoreAllMocks();
  });

  describe('splitTelegramMessage', () => {
    it('returns single chunk when text fits', () => {
      expect(splitTelegramMessage('short')).toEqual(['short']);
    });

    it('splits on newline boundary', () => {
      const text = 'a'.repeat(100) + '\n' + 'b'.repeat(100);
      const chunks = splitTelegramMessage(text, 50);
      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks[0].endsWith('\n')).toBe(false);
    });

    it('splits on space boundary when no newline', () => {
      const text = 'word '.repeat(20).trim();
      const chunks = splitTelegramMessage(text, 10);
      expect(chunks.length).toBeGreaterThan(1);
    });

    it('hard-cuts when no newline or space', () => {
      const text = 'a'.repeat(100);
      const chunks = splitTelegramMessage(text, 10);
      expect(chunks).toHaveLength(10);
      expect(chunks.every((c) => c.length === 10)).toBe(true);
    });

    it('handles exact boundary', () => {
      const text = 'a'.repeat(10);
      expect(splitTelegramMessage(text, 10)).toEqual([text]);
    });
  });

  describe('buildInlineKeyboard', () => {
    it('returns undefined for empty rows', () => {
      expect(buildInlineKeyboard([])).toBeUndefined();
    });

    it('filters buttons with empty text or callback_data', () => {
      const result = buildInlineKeyboard([
        [
          { text: 'ok', callback_data: 'cb' },
          { text: '', callback_data: 'cb2' },
          { text: 'no-cb', callback_data: '' },
        ],
      ]);
      expect(result?.inline_keyboard).toHaveLength(1);
      expect(result?.inline_keyboard[0]).toHaveLength(1);
      expect(result?.inline_keyboard[0][0]).toEqual({ text: 'ok', callback_data: 'cb' });
    });

    it('filters buttons with callback_data exceeding 64 bytes', () => {
      const longCb = 'x'.repeat(65);
      const result = buildInlineKeyboard([[{ text: 'ok', callback_data: longCb }]]);
      expect(result).toBeUndefined();
    });

    it('drops empty rows', () => {
      const result = buildInlineKeyboard([
        [{ text: '', callback_data: '' }],
        [{ text: 'ok', callback_data: 'cb' }],
      ]);
      expect(result?.inline_keyboard).toHaveLength(1);
    });

    it('trims text and callback_data', () => {
      const result = buildInlineKeyboard([[{ text: '  ok  ', callback_data: '  cb  ' }]]);
      expect(result?.inline_keyboard[0][0]).toEqual({ text: 'ok', callback_data: 'cb' });
    });
  });

  describe('deliverTelegram', () => {
    it('sends a single message to private chat', async () => {
      const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await deliverTelegram('private:1', 'Hello');

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const url = urlOf(fetchMock as FetchMock);
      expect(url).toContain('api.telegram.org/bottest-token/sendMessage');
      const body = bodyOf(fetchMock as FetchMock);
      expect(body.chat_id).toBe('chat-1');
      expect(body.text).toBe('Hello');
      expect(body.disable_web_page_preview).toBe(true);
    });

    it('sends multiple chunks for long text', async () => {
      const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await deliverTelegram('private:1', 'a'.repeat(5000));

      expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    });

    it('omits message_thread_id for group thread 1', async () => {
      const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await deliverTelegram('group:1', 'Hello');

      const body = bodyOf(fetchMock as FetchMock);
      expect(body.message_thread_id).toBeUndefined();
    });

    it('includes message_thread_id for group thread > 1', async () => {
      const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await deliverTelegram('group:5', 'Hello');

      const body = bodyOf(fetchMock as FetchMock);
      expect(body.message_thread_id).toBe(5);
    });

    it('includes parse_mode and reply_markup on first chunk', async () => {
      const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await deliverTelegram('private:1', 'Hello', {
        parseMode: 'HTML',
        replyMarkup: { inline_keyboard: [[{ text: 'ok', callback_data: 'cb' }]] },
      });

      const body = bodyOf(fetchMock as FetchMock);
      expect(body.parse_mode).toBe('HTML');
      expect(body.reply_markup).toEqual({
        inline_keyboard: [[{ text: 'ok', callback_data: 'cb' }]],
      });
    });

    it('returns early when no token configured', async () => {
      delete process.env.TELEGRAM_BOT_TOKEN;
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await deliverTelegram('private:1', 'Hello');

      expect(fetchMock).not.toHaveBeenCalled();
      consoleErrorSpy.mockRestore();
    });

    it('throws when response is not ok', async () => {
      const fetchMock = vi.fn(async () => ({
        ok: false,
        status: 400,
        json: async () => ({ description: 'Bad Request' }),
      }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await expect(deliverTelegram('private:1', 'Hello')).rejects.toThrow(
        'Telegram delivery failed',
      );
    });

    it('retries on 429 then succeeds', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 429 })
        .mockResolvedValueOnce({ ok: true, status: 200 });
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      vi.spyOn(globalThis, 'setTimeout').mockImplementation(((cb: () => void) => {
        cb();
        return 0 as unknown as NodeJS.Timeout;
      }) as unknown as typeof setTimeout);

      await deliverTelegram('private:1', 'Hello');

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('throws after max retries on 500', async () => {
      const fetchMock = vi.fn(async () => ({
        ok: false,
        status: 500,
        json: async () => ({ description: 'Server Error' }),
      }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      vi.spyOn(globalThis, 'setTimeout').mockImplementation(((cb: () => void) => {
        cb();
        return 0 as unknown as NodeJS.Timeout;
      }) as unknown as typeof setTimeout);

      await expect(deliverTelegram('private:1', 'Hello')).rejects.toThrow(
        'Telegram delivery failed',
      );
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });
  });

  describe('editTelegramMessage', () => {
    it('edits a message', async () => {
      const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await editTelegramMessage('private:1', 42, 'Updated');

      const url = urlOf(fetchMock as FetchMock);
      expect(url).toContain('editMessageText');
      const body = bodyOf(fetchMock as FetchMock);
      expect(body.message_id).toBe(42);
      expect(body.text).toBe('Updated');
    });

    it('returns early when no token', async () => {
      delete process.env.TELEGRAM_BOT_TOKEN;
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await editTelegramMessage('private:1', 42, 'Updated');

      expect(fetchMock).not.toHaveBeenCalled();
      consoleErrorSpy.mockRestore();
    });

    it('throws when response is not ok', async () => {
      const fetchMock = vi.fn(async () => ({
        ok: false,
        status: 400,
        json: async () => ({ description: 'Bad Request' }),
      }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await expect(editTelegramMessage('private:1', 42, 'Updated')).rejects.toThrow(
        'Telegram edit failed',
      );
    });
  });

  describe('answerTelegramCallbackQuery', () => {
    it('answers callback query', async () => {
      const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await answerTelegramCallbackQuery('cb-1', 'Done', { showAlert: true });

      const url = urlOf(fetchMock as FetchMock);
      expect(url).toContain('answerCallbackQuery');
      const body = bodyOf(fetchMock as FetchMock);
      expect(body.callback_query_id).toBe('cb-1');
      expect(body.text).toBe('Done');
      expect(body.show_alert).toBe(true);
    });

    it('returns early when no token', async () => {
      delete process.env.TELEGRAM_BOT_TOKEN;
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await answerTelegramCallbackQuery('cb-1');

      expect(fetchMock).not.toHaveBeenCalled();
      consoleErrorSpy.mockRestore();
    });

    it('warns but does not throw on non-ok response', async () => {
      const fetchMock = vi.fn(async () => ({
        ok: false,
        status: 400,
        json: async () => ({ description: 'Bad Request' }),
      }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await answerTelegramCallbackQuery('cb-1');

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        'Telegram callback answer failed:',
        expect.anything(),
      );
      consoleWarnSpy.mockRestore();
    });
  });
});
