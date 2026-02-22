import { afterEach, describe, expect, it, vi } from 'vitest';

import { SqliteMessageRepository } from '@/server/channels/messages/sqliteMessageRepository';

describe('SqliteMessageRepository.searchMessages delegation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('delegates search execution to SearchQueries module', () => {
    const repo = new SqliteMessageRepository(':memory:');
    const delegatedResult = [
      {
        id: 'm-1',
        conversationId: 'conv-1',
        role: 'user',
        content: 'hello',
        platform: 'Webchat',
        externalMsgId: null,
        senderName: null,
        metadata: null,
        createdAt: '2026-02-22T00:00:00.000Z',
        seq: 1,
      },
    ];
    const searchMessages = vi.fn(() => delegatedResult);

    (
      repo as unknown as { searchQueries: { searchMessages: typeof searchMessages } }
    ).searchQueries = {
      searchMessages,
    };

    const result = repo.searchMessages('hello', { userId: 'user-a', limit: 5 });

    expect(searchMessages).toHaveBeenCalledWith('hello', { userId: 'user-a', limit: 5 });
    expect(result).toEqual(delegatedResult);
    repo.close();
  });
});
