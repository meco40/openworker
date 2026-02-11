import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('slack pairing', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('pairs slack channel with bot token and stores credentials', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
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

    const { pairChannel } = await import('../../../src/server/channels/pairing');
    const result = await pairChannel('slack', 'xoxb-test-token');

    expect(result).toMatchObject({
      status: 'connected',
      peerName: 'Acme',
    });
  });
});
