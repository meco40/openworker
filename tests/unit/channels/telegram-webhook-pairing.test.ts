import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelType } from '../../../types';
import { CredentialStore } from '../../../src/server/channels/credentials/credentialStore';
import {
  beginTelegramCodePairing,
  confirmTelegramPairingCode,
  ensureTelegramPairingCode,
} from '../../../src/server/channels/pairing/telegramCodePairing';

const handleInbound = vi.fn();

vi.mock('../../../src/server/channels/messages/runtime', () => ({
  getMessageService: () => ({
    handleInbound,
  }),
}));

let telegramWebhookPost: (request: Request) => Promise<Response>;

function makeTelegramWebhookRequest(chatId: number, text: string) {
  return new Request('http://localhost/api/channels/telegram/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-telegram-bot-api-secret-token': 'secret-1',
    },
    body: JSON.stringify({
      update_id: 1,
      message: {
        message_id: 11,
        chat: { id: chatId, type: 'private' },
        from: { id: 22, username: 'alice' },
        text,
      },
    }),
  });
}

describe('telegram webhook pairing gate', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    const route = await import('../../../app/api/channels/telegram/webhook/route');
    telegramWebhookPost = route.POST;
  });

  beforeEach(() => {
    (globalThis as Record<string, unknown>).__credentialStore = new CredentialStore(':memory:');
    const store = (globalThis as Record<string, unknown>).__credentialStore as CredentialStore;
    store.setCredential('telegram', 'bot_token', 'bot-token');
    store.setCredential('telegram', 'webhook_secret', 'secret-1');
    beginTelegramCodePairing();

    handleInbound.mockReset();
    handleInbound.mockResolvedValue(undefined);

    fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
  });

  it('sends a pairing code and skips inbound dispatch while unconfirmed', async () => {
    const response = await telegramWebhookPost(makeTelegramWebhookRequest(123, 'hello'));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/sendMessage'),
      expect.objectContaining({ method: 'POST' }),
    );
    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    const payload = JSON.parse(String(requestInit?.body || '{}')) as {
      chat_id?: string;
      text?: string;
    };
    expect(payload.chat_id).toBe('123');
    expect(payload.text?.toLowerCase()).toContain('pairing code');
    expect(handleInbound).not.toHaveBeenCalled();
  });

  it('dispatches inbound once the chat is confirmed', async () => {
    const issued = ensureTelegramPairingCode('123', new Date('2026-02-10T08:00:00.000Z'));
    if (issued.kind !== 'issued') {
      throw new Error('expected issued code');
    }
    const confirmed = confirmTelegramPairingCode(issued.code, new Date('2026-02-10T08:01:00.000Z'));
    if (!confirmed.ok) {
      throw new Error('expected successful confirmation');
    }
    fetchMock.mockClear();

    const response = await telegramWebhookPost(makeTelegramWebhookRequest(123, 'ready now'));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(handleInbound).toHaveBeenCalledWith(
      ChannelType.TELEGRAM,
      '123',
      'ready now',
      'alice',
      '11',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects messages from a different chat after pairing is connected', async () => {
    const issued = ensureTelegramPairingCode('123', new Date('2026-02-10T08:00:00.000Z'));
    if (issued.kind !== 'issued') {
      throw new Error('expected issued code');
    }
    const confirmed = confirmTelegramPairingCode(issued.code, new Date('2026-02-10T08:01:00.000Z'));
    if (!confirmed.ok) {
      throw new Error('expected successful confirmation');
    }
    fetchMock.mockClear();

    const response = await telegramWebhookPost(makeTelegramWebhookRequest(999, 'intruder'));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    const payload = JSON.parse(String(requestInit?.body || '{}')) as { text?: string };
    expect(payload.text?.toLowerCase()).toContain('already paired');
    expect(handleInbound).not.toHaveBeenCalled();
  });
});
