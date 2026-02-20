import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('slack pairing', () => {
  let previousMessagesDbPath: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    previousMessagesDbPath = process.env.MESSAGES_DB_PATH;
    process.env.MESSAGES_DB_PATH = ':memory:';
    globalThis.__credentialStore = undefined;
  });

  afterEach(() => {
    process.env.MESSAGES_DB_PATH = previousMessagesDbPath;
    globalThis.__credentialStore = undefined;
  });

  it('pairs slack channel with bot token and stores credentials', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ok: true,
              team: 'Acme',
              team_id: 'T1',
              user: 'bot-user',
              bot_id: 'B1',
            }),
            { status: 200 },
          ),
      ),
    );

    const { pairChannel } = await import('@/server/channels/pairing');
    const result = await pairChannel('slack', 'xoxb-test-token');

    expect(result).toMatchObject({
      status: 'connected',
      peerName: 'Acme',
    });
  });
});
