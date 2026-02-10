import { beforeEach, describe, expect, it, vi } from 'vitest';
import { POST as pollPost } from '../../../app/api/channels/telegram/pairing/poll/route';
import { CredentialStore } from '../../../src/server/channels/credentials/credentialStore';
import { beginTelegramCodePairing } from '../../../src/server/channels/pairing/telegramCodePairing';

function makeRequest() {
  return new Request('http://localhost/api/channels/telegram/pairing/poll', {
    method: 'POST',
  });
}

describe('telegram pairing poll route', () => {
  beforeEach(() => {
    (globalThis as Record<string, unknown>).__credentialStore = new CredentialStore(':memory:');
    const store = (globalThis as Record<string, unknown>).__credentialStore as CredentialStore;
    store.setCredential('telegram', 'bot_token', 'bot-token');
    store.setCredential('telegram', 'webhook_secret', 'secret-1');
    beginTelegramCodePairing();
  });

  it('polls updates and issues pairing code when transport is polling', async () => {
    const store = (globalThis as Record<string, unknown>).__credentialStore as CredentialStore;
    store.setCredential('telegram', 'update_transport', 'polling');

    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            result: [
              {
                update_id: 101,
                message: {
                  message_id: 10,
                  chat: { id: 222, type: 'private' },
                  from: { id: 333, username: 'alice' },
                  text: 'hello',
                },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

    const response = await pollPost(makeRequest());
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.mode).toBe('polling');
    expect(json.processed).toBe(1);
    expect(json.codeIssued).toBe(true);
    expect(store.getCredential('telegram', 'polling_offset')).toBe('102');
    fetchMock.mockRestore();
  });

  it('skips polling when transport is webhook', async () => {
    const store = (globalThis as Record<string, unknown>).__credentialStore as CredentialStore;
    store.setCredential('telegram', 'update_transport', 'webhook');
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    const response = await pollPost(makeRequest());
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.mode).toBe('webhook');
    expect(json.processed).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockRestore();
  });
});
