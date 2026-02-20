import { describe, expect, it } from 'vitest';

import { ChannelType } from '@/shared/domain/types';
import { loadChannelState } from '@/modules/app-shell/useChannelStateSync';

describe('channel state sync', () => {
  it('maps /api/channels/state payload into coupled-channel updates', async () => {
    const updates = await loadChannelState(
      async () =>
        new Response(
          JSON.stringify({
            ok: true,
            channels: [
              { channel: 'telegram', status: 'connected', peerName: 'telegram:test' },
              { channel: 'slack', status: 'idle' },
              { channel: 'unknown', status: 'connected' },
            ],
          }),
          { status: 200 },
        ),
    );

    expect(updates.telegram).toMatchObject({
      type: ChannelType.TELEGRAM,
      status: 'connected',
      peerName: 'telegram:test',
    });
    expect(updates.slack).toMatchObject({
      type: ChannelType.SLACK,
      status: 'idle',
    });
    expect(updates.unknown).toBeUndefined();
  });

  it('returns empty updates when state endpoint fails', async () => {
    const updates = await loadChannelState(
      async () => new Response(JSON.stringify({ ok: false }), { status: 500 }),
    );
    expect(updates).toEqual({});
  });
});
