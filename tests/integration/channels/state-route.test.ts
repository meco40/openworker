import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LEGACY_LOCAL_USER_ID } from '../../../src/server/auth/constants';
import { SqliteMessageRepository } from '../../../src/server/channels/messages/sqliteMessageRepository';

describe('GET /api/channels/state', () => {
  let repo: SqliteMessageRepository;
  let previousFlag: string | undefined;

  beforeEach(() => {
    previousFlag = process.env.CHAT_PERSISTENT_SESSION_V2;
    process.env.CHAT_PERSISTENT_SESSION_V2 = 'false';

    repo = new SqliteMessageRepository(':memory:');
    repo.upsertChannelBinding({
      userId: LEGACY_LOCAL_USER_ID,
      channel: 'telegram',
      status: 'connected',
      externalPeerId: 'chat-123',
      peerName: 'telegram:chat-123',
    });

    globalThis.__messageRepository = repo;
    globalThis.__messageService = undefined;
  });

  afterEach(() => {
    repo.close();
    globalThis.__messageRepository = undefined;
    globalThis.__messageService = undefined;
    process.env.CHAT_PERSISTENT_SESSION_V2 = previousFlag;
  });

  it('returns channel state merged with capability metadata', async () => {
    const { GET } = await import('../../../app/api/channels/state/route');
    const response = await GET();
    const json = (await response.json()) as {
      ok: boolean;
      channels: Array<{ channel: string; status: string; supportsInbound: boolean }>;
    };

    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.channels.length).toBeGreaterThan(0);
    const telegram = json.channels.find((entry) => entry.channel === 'telegram');
    expect(telegram?.status).toBe('connected');
    expect(telegram?.supportsInbound).toBe(true);
  });
});
