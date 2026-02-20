import { describe, expect, it } from 'vitest';

import { SqliteMessageRepository } from '@/server/channels/messages/sqliteMessageRepository';

describe('channel bindings repository', () => {
  it('stores and lists per-user channel bindings', () => {
    const repo = new SqliteMessageRepository(':memory:');

    repo.upsertChannelBinding({
      userId: 'user-a',
      channel: 'telegram',
      status: 'connected',
      externalPeerId: 'chat-1',
      peerName: 'telegram:chat-1',
    });

    const bindings = repo.listChannelBindings('user-a');
    expect(bindings).toHaveLength(1);
    expect(bindings[0].channel).toBe('telegram');
    expect(bindings[0].status).toBe('connected');
    expect(bindings[0].externalPeerId).toBe('chat-1');
  });

  it('updates last seen timestamp for a channel binding', () => {
    const repo = new SqliteMessageRepository(':memory:');

    repo.upsertChannelBinding({
      userId: 'user-a',
      channel: 'discord',
      status: 'connected',
    });

    const before = repo.listChannelBindings('user-a')[0].lastSeenAt;
    repo.touchChannelLastSeen('user-a', 'discord', '2026-02-11T12:00:00.000Z');
    const after = repo.listChannelBindings('user-a')[0].lastSeenAt;

    expect(before).toBeNull();
    expect(after).toBe('2026-02-11T12:00:00.000Z');
  });
});
