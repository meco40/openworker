import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CredentialStore } from '@/server/channels/credentials/credentialStore';

const startTelegramPolling = vi.fn(async () => {});
const stopTelegramPolling = vi.fn();
const syncTelegramNativeCommands = vi.fn(async () => {});

vi.mock('../../../src/server/channels/pairing/telegramPolling', () => ({
  startTelegramPolling,
  stopTelegramPolling,
}));

vi.mock('../../../src/server/channels/telegram/nativeCommands', () => ({
  syncTelegramNativeCommands,
}));

describe('pairTelegram', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.APP_URL;
    delete process.env.NEXTAUTH_URL;
    delete process.env.VERCEL_URL;
    vi.clearAllMocks();

    (globalThis as Record<string, unknown>).__credentialStore = new CredentialStore(':memory:');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.includes('/getMe')) {
          return {
            ok: true,
            json: async () => ({
              ok: true,
              result: { username: 'global_bot', id: 12345 },
            }),
          } as Response;
        }

        if (url.includes('/deleteWebhook')) {
          return {
            ok: true,
            json: async () => ({ ok: true }),
          } as Response;
        }

        throw new Error(`Unexpected fetch URL: ${url}`);
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  it('syncs Telegram native commands during global pairing', async () => {
    const { pairTelegram } = await import('@/server/channels/pairing/telegram');

    const result = await pairTelegram('global-token');

    expect(result.status).toBe('awaiting_code');
    expect(startTelegramPolling).toHaveBeenCalledTimes(1);
    expect(stopTelegramPolling).toHaveBeenCalledTimes(1);
    expect(syncTelegramNativeCommands).toHaveBeenCalledWith('global-token');
  });
});
