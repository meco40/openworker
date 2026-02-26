import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type TestGlobals = typeof globalThis & {
  __credentialStore?: unknown;
};

describe('telegram unpair hard disconnect', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    (globalThis as TestGlobals).__credentialStore = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    (globalThis as TestGlobals).__credentialStore = undefined;
  });

  it('stops telegram polling when disconnecting', async () => {
    const stopTelegramPolling = vi.fn();

    vi.doMock('@/server/channels/pairing/telegramPolling', () => ({
      stopTelegramPolling,
    }));

    const { CredentialStore } = await import('@/server/channels/credentials/credentialStore');
    const store = new CredentialStore(':memory:');
    store.setCredential('telegram', 'bot_token', 'tg-token');
    (globalThis as TestGlobals).__credentialStore = store;

    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const { unpairChannel } = await import('@/server/channels/pairing/unpair');
    await unpairChannel('telegram');

    expect(stopTelegramPolling).toHaveBeenCalledTimes(1);
    fetchMock.mockRestore();
  });

  it('fails disconnect when telegram credentials still exist afterwards', async () => {
    const stopTelegramPolling = vi.fn();
    const deleteCredentials = vi.fn();
    const getCredential = vi.fn((channel: string, key: string) => {
      if (channel === 'telegram' && key === 'bot_token') {
        return 'still-present';
      }
      return null;
    });
    const listCredentials = vi.fn((channel: string) => {
      if (channel === 'telegram') {
        return [{ channel: 'telegram', key: 'bot_token', value: 'still-present' }];
      }
      return [];
    });

    vi.doMock('@/server/channels/credentials', () => ({
      getCredentialStore: () => ({
        getCredential,
        deleteCredentials,
        listCredentials,
      }),
    }));
    vi.doMock('@/server/channels/pairing/telegramPolling', () => ({
      stopTelegramPolling,
    }));

    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const { unpairChannel } = await import('@/server/channels/pairing/unpair');

    await expect(unpairChannel('telegram')).rejects.toThrow(
      'Telegram disconnect incomplete: bot token still present in credential store.',
    );

    expect(deleteCredentials).toHaveBeenCalledWith('telegram');
    fetchMock.mockRestore();
  });
});
