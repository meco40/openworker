import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PersonaTelegramBotRegistry } from '@/server/telegram/personaTelegramBotRegistry';

const pollerMocks = vi.hoisted(() => ({
  startPersonaBotPolling: vi.fn(async () => {}),
  stopPersonaBotPolling: vi.fn(),
}));

vi.mock('@/server/telegram/personaTelegramPoller', () => pollerMocks);

describe('pairPersonaTelegram', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.APP_URL;
    delete process.env.NEXTAUTH_URL;
    delete process.env.VERCEL_URL;

    (globalThis as Record<string, unknown>).__personaTelegramBotRegistry =
      new PersonaTelegramBotRegistry(':memory:');

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.includes('/getMe')) {
          return {
            ok: true,
            json: async () => ({
              ok: true,
              result: { username: 'shared_bot', id: 123456 },
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

  it('rejects pairing the same token twice', async () => {
    const { pairPersonaTelegram } = await import('@/server/telegram/personaTelegramPairing');

    await pairPersonaTelegram('persona-1', 'shared-token');

    await expect(pairPersonaTelegram('persona-2', 'shared-token')).rejects.toThrow(
      /already paired/i,
    );
  });
});
