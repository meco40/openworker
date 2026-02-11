import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { POST as pollPost } from '../../../app/api/channels/telegram/pairing/poll/route';
import { CredentialStore } from '../../../src/server/channels/credentials/credentialStore';
import { beginTelegramCodePairing } from '../../../src/server/channels/pairing/telegramCodePairing';
import { stopTelegramPolling } from '../../../src/server/channels/pairing/telegramPolling';

function makeRequest() {
  return new Request('http://localhost/api/channels/telegram/pairing/poll', {
    method: 'POST',
  });
}

describe('telegram pairing poll route', () => {
  beforeEach(() => {
    (globalThis as Record<string, unknown>).__credentialStore = new CredentialStore(':memory:');
    (globalThis as Record<string, unknown>).__telegramPollingActive = false;
    (globalThis as Record<string, unknown>).__telegramPollingTimer = undefined;
    const store = (globalThis as Record<string, unknown>).__credentialStore as CredentialStore;
    store.setCredential('telegram', 'bot_token', 'bot-token');
    store.setCredential('telegram', 'webhook_secret', 'secret-1');
    beginTelegramCodePairing();
  });

  afterEach(() => {
    stopTelegramPolling();
  });

  it('starts background poller and delegates when transport is polling', async () => {
    const store = (globalThis as Record<string, unknown>).__credentialStore as CredentialStore;
    store.setCredential('telegram', 'update_transport', 'polling');

    // Mock fetch so the deleteWebhook call inside startTelegramPolling succeeds
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const response = await pollPost(makeRequest());
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.mode).toBe('polling');
    expect(json.delegated).toBe(true);
    // Should only call deleteWebhook, NOT getUpdates
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain('/deleteWebhook');
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
    // Webhook mode — no fetch calls at all
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockRestore();
  });
});
