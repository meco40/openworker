import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LEGACY_LOCAL_USER_ID } from '@/server/auth/constants';
import { SqliteMessageRepository } from '@/server/channels/messages/sqliteMessageRepository';

describe('GET /api/channels/state', () => {
  let repo: SqliteMessageRepository;
  let previousFlag: string | undefined;
  let previousRequireAuth: string | undefined;

  beforeEach(() => {
    previousFlag = process.env.CHAT_PERSISTENT_SESSION_V2;
    previousRequireAuth = process.env.REQUIRE_AUTH;
    process.env.CHAT_PERSISTENT_SESSION_V2 = 'false';
    delete process.env.REQUIRE_AUTH;

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
    if (previousRequireAuth === undefined) {
      delete process.env.REQUIRE_AUTH;
    } else {
      process.env.REQUIRE_AUTH = previousRequireAuth;
    }
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

  it('returns 401 when REQUIRE_AUTH is true and no session exists', async () => {
    process.env.REQUIRE_AUTH = 'true';
    const { GET } = await import('../../../app/api/channels/state/route');
    const response = await GET();

    expect(response.status).toBe(401);
  });

  it('returns same auth behavior regardless of chat session flag', async () => {
    process.env.REQUIRE_AUTH = 'true';
    process.env.CHAT_PERSISTENT_SESSION_V2 = 'false';
    const { GET } = await import('../../../app/api/channels/state/route');
    const responseWhenFlagOff = await GET();

    process.env.CHAT_PERSISTENT_SESSION_V2 = 'true';
    const responseWhenFlagOn = await GET();

    expect(responseWhenFlagOff.status).toBe(401);
    expect(responseWhenFlagOn.status).toBe(401);
  });
});
