import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CredentialStore } from '@/server/channels/credentials/credentialStore';
import { deliverTelegram, editTelegramMessage } from '@/server/channels/outbound/telegram';

describe('telegram outbound threading', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    (globalThis as Record<string, unknown>).__credentialStore = new CredentialStore(':memory:');
    const store = (globalThis as Record<string, unknown>).__credentialStore as CredentialStore;
    store.setCredential('telegram', 'bot_token', 'bot-token');
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
  });

  it('sends topic messages with message_thread_id', async () => {
    await deliverTelegram('telegram:group:-100123:topic:42', 'hello');

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    const payload = JSON.parse(String(requestInit?.body || '{}')) as Record<string, unknown>;
    expect(payload.chat_id).toBe('-100123');
    expect(payload.message_thread_id).toBe(42);
  });

  it('omits message_thread_id for general forum topic id=1', async () => {
    await deliverTelegram('telegram:group:-100123:topic:1', 'hello');

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    const payload = JSON.parse(String(requestInit?.body || '{}')) as Record<string, unknown>;
    expect(payload.chat_id).toBe('-100123');
    expect(payload.message_thread_id).toBeUndefined();
  });

  it('keeps thread id for direct-topic edits', async () => {
    await editTelegramMessage('telegram:12345:topic:7', 11, 'updated');

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    const payload = JSON.parse(String(requestInit?.body || '{}')) as Record<string, unknown>;
    expect(payload.chat_id).toBe('12345');
    expect(payload.message_thread_id).toBe(7);
  });

  it('retries sendMessage on retryable Telegram API errors', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: false, error_code: 429 }), {
          status: 429,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

    await deliverTelegram('telegram:12345', 'retry me');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
