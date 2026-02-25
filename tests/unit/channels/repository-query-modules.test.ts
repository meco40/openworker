import { afterEach, describe, expect, it, vi } from 'vitest';

import { ContextQueries } from '@/server/channels/messages/repository/queries/context';
import { SearchQueries } from '@/server/channels/messages/repository/queries/search';
import { DeleteQueries } from '@/server/channels/messages/repository/queries/delete';
import { ChannelType } from '@/shared/domain/types';

type MockStatement = {
  get?: ReturnType<typeof vi.fn>;
  all?: ReturnType<typeof vi.fn>;
  run?: ReturnType<typeof vi.fn>;
};

function makeDb(prepareImpl: (sql: string) => MockStatement) {
  return {
    prepare: vi.fn((sql: string) => prepareImpl(sql)),
    exec: vi.fn(),
  };
}

describe('ContextQueries', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('returns null when conversation is not visible', () => {
    const db = makeDb(() => ({ get: vi.fn() }));
    const queries = new ContextQueries(db as never);

    const result = queries.getConversationContext('conv-1', () => null, 'user-a');

    expect(result).toBeNull();
    expect(db.prepare).not.toHaveBeenCalled();
  });

  it('returns null when context row does not exist', () => {
    const db = makeDb(() => ({ get: vi.fn() }));
    const queries = new ContextQueries(db as never);

    const result = queries.getConversationContext(
      'conv-1',
      () =>
        ({
          id: 'conv-1',
          channelType: ChannelType.WEBCHAT,
        }) as never,
      'user-a',
    );

    expect(result).toBeNull();
    expect(db.prepare).toHaveBeenCalledWith(
      'SELECT * FROM conversation_context WHERE conversation_id = ?',
    );
  });

  it('maps conversation context row to state', () => {
    const db = makeDb(() => ({
      get: vi.fn(() => ({
        conversation_id: 'conv-1',
        summary_text: 'Summary',
        summary_upto_seq: 11,
        updated_at: '2026-02-22T00:00:00.000Z',
      })),
    }));
    const queries = new ContextQueries(db as never);

    const result = queries.getConversationContext(
      'conv-1',
      () =>
        ({
          id: 'conv-1',
          channelType: ChannelType.WEBCHAT,
        }) as never,
      'user-a',
    );

    expect(result).toEqual({
      conversationId: 'conv-1',
      summaryText: 'Summary',
      summaryUptoSeq: 11,
      updatedAt: '2026-02-22T00:00:00.000Z',
    });
  });

  it('throws when upserting context for missing conversation', () => {
    const db = makeDb(() => ({ run: vi.fn() }));
    const queries = new ContextQueries(db as never);

    expect(() =>
      queries.upsertConversationContext('conv-missing', 'Summary', 1, () => null, 'user-a'),
    ).toThrow('Conversation not found for context update.');
  });

  it('upserts context and returns persisted state', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-22T01:00:00.000Z'));
    const run = vi.fn();
    const db = makeDb(() => ({ run }));
    const queries = new ContextQueries(db as never);

    const result = queries.upsertConversationContext(
      'conv-1',
      'Context summary',
      42,
      () =>
        ({
          id: 'conv-1',
          channelType: ChannelType.WEBCHAT,
        }) as never,
      'user-a',
    );

    expect(run).toHaveBeenCalledWith('conv-1', 'Context summary', 42, '2026-02-22T01:00:00.000Z');
    expect(result).toEqual({
      conversationId: 'conv-1',
      summaryText: 'Context summary',
      summaryUptoSeq: 42,
      updatedAt: '2026-02-22T01:00:00.000Z',
    });
  });
});

describe('SearchQueries', () => {
  it('returns empty list for blank query without touching DB', () => {
    const db = makeDb(() => ({ all: vi.fn() }));
    const queries = new SearchQueries(db as never);

    const result = queries.searchMessages('   ', { userId: 'user-a' });

    expect(result).toEqual([]);
    expect(db.prepare).not.toHaveBeenCalled();
  });

  it('builds filtered query and clamps limit boundaries', () => {
    const all = vi.fn(() => [
      {
        id: 'm-1',
        conversation_id: 'conv-1',
        seq: 1,
        role: 'user',
        content: 'hello',
        platform: ChannelType.WEBCHAT,
        external_msg_id: null,
        sender_name: null,
        metadata: null,
        created_at: '2026-02-22T00:00:00.000Z',
      },
    ]);
    const db = makeDb(() => ({ all }));
    const queries = new SearchQueries(db as never);

    const result = queries.searchMessages('hello world', {
      userId: 'user-a',
      conversationId: 'conv-1',
      personaId: 'persona-a',
      role: 'user',
      limit: 9999,
    });

    const [sql] = db.prepare.mock.calls[0] as [string];
    expect(sql).toContain('c.user_id = ?');
    expect(sql).toContain('m.conversation_id = ?');
    expect(sql).toContain('c.persona_id = ?');
    expect(sql).toContain('m.role = ?');
    const params = all.mock.calls[0] as unknown as [string, string, string, string, string, number];
    expect(params[1]).toBe('user-a');
    expect(params[2]).toBe('conv-1');
    expect(params[3]).toBe('persona-a');
    expect(params[4]).toBe('user');
    expect(params[5]).toBe(200);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('m-1');
  });

  it('uses minimum limit of 1 when limit is <= 0', () => {
    const all = vi.fn(() => []);
    const db = makeDb(() => ({ all }));
    const queries = new SearchQueries(db as never);

    queries.searchMessages('needle', { limit: 0 });

    const params = all.mock.calls[0] as unknown[];
    expect(params[params.length - 1]).toBe(1);
  });
});

describe('DeleteQueries', () => {
  it('returns false when conversation is not found for user scope', () => {
    const db = makeDb(() => ({ run: vi.fn() }));
    const normalizeUserId = vi.fn((userId?: string) => `normalized:${userId ?? ''}`);
    const queries = new DeleteQueries(db as never, normalizeUserId);

    const deleted = queries.deleteConversation('conv-1', 'user-a', () => null);

    expect(deleted).toBe(false);
    expect(normalizeUserId).toHaveBeenCalledWith('user-a');
    expect(db.prepare).not.toHaveBeenCalled();
  });

  it('deletes messages, context, knowledge artifacts and conversation', () => {
    const runCalls: Array<{ sql: string; args: unknown[] }> = [];
    const db = makeDb((sql) => ({
      run: vi.fn((...args: unknown[]) => {
        runCalls.push({ sql, args });
      }),
    }));
    const normalizeUserId = vi.fn((userId?: string) => `normalized:${userId ?? ''}`);
    const queries = new DeleteQueries(db as never, normalizeUserId);

    const deleted = queries.deleteConversation(
      'conv-1',
      'user-a',
      () =>
        ({
          id: 'conv-1',
          channelType: ChannelType.WEBCHAT,
        }) as never,
    );

    expect(deleted).toBe(true);
    expect(runCalls[0]).toEqual({
      sql: 'DELETE FROM messages WHERE conversation_id = ?',
      args: ['conv-1'],
    });
    expect(runCalls.some((entry) => entry.sql.includes('conversation_context'))).toBe(true);
    expect(runCalls.some((entry) => entry.sql.includes('conversation_project_state'))).toBe(true);
    expect(runCalls.some((entry) => entry.sql.includes('knowledge_episodes'))).toBe(true);
    expect(runCalls.some((entry) => entry.sql.includes('knowledge_meeting_ledger'))).toBe(true);
    expect(runCalls.some((entry) => entry.sql.includes('knowledge_retrieval_audit'))).toBe(true);
    expect(runCalls[runCalls.length - 1]).toEqual({
      sql: 'DELETE FROM conversations WHERE id = ? AND user_id = ?',
      args: ['conv-1', 'normalized:user-a'],
    });
  });

  it('rebuilds FTS index and retries delete when messages table is malformed', () => {
    let firstDelete = true;
    const db = makeDb((sql) => ({
      run: vi.fn((...args: unknown[]) => {
        if (sql === 'DELETE FROM messages WHERE conversation_id = ?' && firstDelete) {
          firstDelete = false;
          throw new Error('database disk image is malformed');
        }
        return args;
      }),
    }));
    const normalizeUserId = vi.fn((userId?: string) => userId?.trim() || 'legacy');
    const queries = new DeleteQueries(db as never, normalizeUserId);

    const deleted = queries.deleteConversation(
      'conv-1',
      ' user-a ',
      () =>
        ({
          id: 'conv-1',
          channelType: ChannelType.WEBCHAT,
        }) as never,
    );

    expect(deleted).toBe(true);
    expect(db.exec).toHaveBeenCalledWith(
      `INSERT INTO messages_fts(messages_fts) VALUES('rebuild')`,
    );
  });

  it('rethrows message delete errors that are not corruption-related', () => {
    const db = makeDb((sql) => ({
      run: vi.fn(() => {
        if (sql === 'DELETE FROM messages WHERE conversation_id = ?') {
          throw new Error('database locked');
        }
      }),
    }));
    const normalizeUserId = vi.fn((userId?: string) => userId?.trim() || 'legacy');
    const queries = new DeleteQueries(db as never, normalizeUserId);

    expect(() =>
      queries.deleteConversation(
        'conv-1',
        'user-a',
        () =>
          ({
            id: 'conv-1',
            channelType: ChannelType.WEBCHAT,
          }) as never,
      ),
    ).toThrow('database locked');
    expect(db.exec).not.toHaveBeenCalled();
  });

  it('swallows missing knowledge-table deletes and still deletes conversation', () => {
    const runCalls: Array<{ sql: string; args: unknown[] }> = [];
    const db = makeDb((sql) => ({
      run: vi.fn((...args: unknown[]) => {
        runCalls.push({ sql, args });
        if (sql.includes('knowledge_episodes')) {
          throw new Error('no such table: knowledge_episodes');
        }
      }),
    }));
    const normalizeUserId = vi.fn((userId?: string) => userId?.trim() || 'legacy');
    const queries = new DeleteQueries(db as never, normalizeUserId);

    const deleted = queries.deleteConversation(
      'conv-1',
      'user-a',
      () =>
        ({
          id: 'conv-1',
          channelType: ChannelType.WEBCHAT,
        }) as never,
    );

    expect(deleted).toBe(true);
    expect(runCalls[runCalls.length - 1].sql).toBe(
      'DELETE FROM conversations WHERE id = ? AND user_id = ?',
    );
  });

  it('returns false when message is not found for user scope', () => {
    const db = makeDb(() => ({ run: vi.fn() }));
    const normalizeUserId = vi.fn((userId?: string) => `normalized:${userId ?? ''}`);
    const queries = new DeleteQueries(db as never, normalizeUserId);

    const deleted = queries.deleteMessage('msg-1', 'user-a', () => null);

    expect(deleted).toBe(false);
    expect(normalizeUserId).toHaveBeenCalledWith('user-a');
    expect(db.prepare).not.toHaveBeenCalled();
  });

  it('deletes one message and invalidates derived conversation data', () => {
    const runCalls: Array<{ sql: string; args: unknown[] }> = [];
    const db = makeDb((sql) => ({
      run: vi.fn((...args: unknown[]) => {
        runCalls.push({ sql, args });
        if (sql.includes('DELETE FROM messages')) {
          return { changes: 1 };
        }
        return { changes: 0 };
      }),
    }));
    const normalizeUserId = vi.fn((userId?: string) => `normalized:${userId ?? ''}`);
    const queries = new DeleteQueries(db as never, normalizeUserId);

    const deleted = queries.deleteMessage(
      'msg-1',
      'user-a',
      () =>
        ({
          id: 'msg-1',
          conversationId: 'conv-1',
        }) as never,
    );

    expect(deleted).toBe(true);
    expect(runCalls.some((entry) => entry.sql.includes('DELETE FROM messages'))).toBe(true);
    expect(runCalls.some((entry) => entry.sql.includes('conversation_context'))).toBe(true);
    expect(runCalls.some((entry) => entry.sql.includes('knowledge_episodes'))).toBe(true);
    expect(runCalls.some((entry) => entry.sql.includes('knowledge_meeting_ledger'))).toBe(true);
    expect(runCalls.some((entry) => entry.sql.includes('knowledge_retrieval_audit'))).toBe(true);
    expect(runCalls.some((entry) => entry.sql.includes('UPDATE conversations SET updated_at = ?'))).toBe(
      true,
    );
  });
});
