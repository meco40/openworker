import { describe, expect, it, vi } from 'vitest';
import type { MemoryNode, MemoryType } from '@/core/memory/types';
import type {
  Mem0Client,
  Mem0ListInput,
  Mem0ListMemoryResult,
  Mem0MemoryInput,
  Mem0MemoryRecord,
  Mem0SearchHit,
  Mem0SearchInput,
} from '@/server/memory/mem0';
import { getServerEventBus } from '@/server/events/runtime';
import { MemoryService } from '@/server/memory/service';

function scopeKey(userId: string, personaId: string): string {
  return `${userId}::${personaId}`;
}

function defaultRecord(id: string, input: Mem0MemoryInput): Mem0MemoryRecord {
  return {
    id,
    content: input.content,
    score: null,
    metadata: {
      ...input.metadata,
      type: String(input.metadata.type || 'fact'),
      importance: Number(input.metadata.importance || 3),
      confidence: Number(input.metadata.confidence || 0.3),
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function timestampAtMinute(minute: number): string {
  return new Date(Date.UTC(2026, 9, 8, 10, minute)).toISOString();
}

function createInMemoryMem0Client(): Mem0Client {
  const byScope = new Map<string, Mem0MemoryRecord[]>();
  const historyById = new Map<string, Array<Record<string, unknown>>>();

  const readScope = (userId: string, personaId: string): Mem0MemoryRecord[] =>
    byScope.get(scopeKey(userId, personaId)) || [];

  const writeScope = (userId: string, personaId: string, rows: Mem0MemoryRecord[]) => {
    byScope.set(scopeKey(userId, personaId), rows);
  };

  const findById = (
    id: string,
  ): { key: string; index: number; record: Mem0MemoryRecord } | null => {
    for (const [key, records] of byScope.entries()) {
      const index = records.findIndex((record) => record.id === id);
      if (index >= 0) {
        return { key, index, record: records[index] };
      }
    }
    return null;
  };

  return {
    addMemory: async (input: Mem0MemoryInput) => {
      const id = `mem0-${Math.random().toString(36).slice(2, 10)}`;
      const row = defaultRecord(id, input);
      const next = [...readScope(input.userId, input.personaId), row];
      writeScope(input.userId, input.personaId, next);
      historyById.set(id, [
        {
          action: 'create',
          timestamp: row.createdAt,
          content: row.content,
          metadata: row.metadata,
        },
      ]);
      return { id };
    },

    searchMemories: async (input: Mem0SearchInput): Promise<Mem0SearchHit[]> => {
      const rows = readScope(input.userId, input.personaId)
        .filter((row) => row.content.toLowerCase().includes(input.query.toLowerCase()))
        .slice(0, Math.max(1, input.limit));

      return rows.map((row) => ({
        id: row.id,
        content: row.content,
        score: 0.91,
        metadata: row.metadata,
      }));
    },

    listMemories: async (input: Mem0ListInput): Promise<Mem0ListMemoryResult> => {
      const page = Math.max(1, Math.floor(input.page));
      const pageSize = Math.max(1, Math.floor(input.pageSize));
      const personaId = input.personaId || '';
      const source = personaId
        ? readScope(input.userId, personaId)
        : Array.from(byScope.entries())
            .filter(([key]) => key.startsWith(`${input.userId}::`))
            .flatMap(([, value]) => value);
      const filtered = source.filter((row) => {
        const queryOk = input.query
          ? row.content.toLowerCase().includes(input.query.toLowerCase())
          : true;
        const typeOk = input.type ? String(row.metadata.type) === input.type : true;
        return queryOk && typeOk;
      });
      const offset = (page - 1) * pageSize;
      return {
        memories: filtered.slice(offset, offset + pageSize),
        total: filtered.length,
        page,
        pageSize,
      };
    },

    getMemory: async (id: string) => {
      const found = findById(id);
      return found ? found.record : null;
    },

    getMemoryHistory: async (id: string) => {
      const entries = historyById.get(id) || [];
      return entries.map((entry) => ({
        action: String(entry.action || 'unknown'),
        timestamp: typeof entry.timestamp === 'string' ? entry.timestamp : undefined,
        content: typeof entry.content === 'string' ? entry.content : undefined,
        metadata:
          entry.metadata && typeof entry.metadata === 'object'
            ? (entry.metadata as Record<string, unknown>)
            : {},
        raw: entry,
      }));
    },

    updateMemory: async (id: string, input: Mem0MemoryInput) => {
      const found = findById(id);
      if (!found) {
        throw new Error('Mem0 request failed with HTTP 404.');
      }
      const nextRow: Mem0MemoryRecord = {
        ...found.record,
        content: input.content,
        metadata: { ...input.metadata },
        updatedAt: new Date().toISOString(),
      };
      const rows = [...(byScope.get(found.key) || [])];
      rows[found.index] = nextRow;
      byScope.set(found.key, rows);
      historyById.set(id, [
        ...(historyById.get(id) || []),
        {
          action: 'update',
          timestamp: nextRow.updatedAt,
          content: nextRow.content,
          metadata: nextRow.metadata,
        },
      ]);
    },

    deleteMemory: async (id: string) => {
      const found = findById(id);
      if (!found) {
        throw new Error('Mem0 request failed with HTTP 404.');
      }
      const rows = [...(byScope.get(found.key) || [])];
      rows.splice(found.index, 1);
      byScope.set(found.key, rows);
    },

    deleteMemoriesByFilter: async (input: { userId: string; personaId: string }) => {
      const key = scopeKey(input.userId, input.personaId);
      const existing = byScope.get(key) || [];
      byScope.delete(key);
      return existing.length;
    },
  };
}

describe('MemoryService (mem0-only)', () => {
  it('stores a memory and returns mem0-backed node metadata', async () => {
    const service = new MemoryService(createInMemoryMem0Client());

    const node = await service.store('persona-a', 'fact', 'likes coffee', 4, 'user-a');

    expect(node.id.startsWith('mem0-')).toBe(true);
    expect(node.metadata?.memoryProvider).toBe('mem0');
    expect(node.content).toBe('likes coffee');
  });

  it('persists optional evidence metadata during store', async () => {
    const service = new MemoryService(createInMemoryMem0Client());

    const node = await service.store('persona-a', 'fact', 'meeting summary', 4, 'user-a', {
      topicKey: 'meeting-andreas',
      conversationId: 'conv-42',
      sourceSeqStart: 101,
      sourceSeqEnd: 128,
      artifactType: 'episode',
    });

    expect(node.metadata?.topicKey).toBe('meeting-andreas');
    expect(node.metadata?.conversationId).toBe('conv-42');
    expect(node.metadata?.sourceSeqStart).toBe(101);
    expect(node.metadata?.sourceSeqEnd).toBe(128);
    expect(node.metadata?.artifactType).toBe('episode');
  });

  it('recalls relevant context via mem0 search results', async () => {
    const service = new MemoryService(createInMemoryMem0Client());
    await service.store('persona-a', 'preference', 'prefers oat milk', 4, 'user-a');

    const context = await service.recall('persona-a', 'oat', 3, 'user-a');

    expect(context).toContain('[Type: preference] prefers oat milk');
  });

  it('falls back to list query when mem0 search scores are too low', async () => {
    const client = createInMemoryMem0Client();
    const service = new MemoryService(client);
    const stored = await service.store('persona-a', 'fact', 'alpha fallback memory', 4, 'user-a');

    client.searchMemories = async () => [
      {
        id: stored.id,
        content: stored.content,
        score: 0.1,
        metadata: { type: 'fact', importance: 4, confidence: 0.3 },
      },
    ];

    const context = await service.recall('persona-a', 'fallback', 3, 'user-a');
    expect(context).toContain('[Type: fact] alpha fallback memory');
  });

  it('uses self-reference variants in semantic lexical fallback queries', async () => {
    const client = createInMemoryMem0Client();
    const service = new MemoryService(client);
    const stored = await service.store('persona-a', 'fact', 'ich mag Orangensaft', 4, 'user-a');
    client.searchMemories = async () => [
      {
        id: stored.id,
        content: stored.content,
        score: 0.1,
        metadata: stored.metadata || {},
      },
    ];

    const context = await service.recall('persona-a', 'du mag Orangensaft', 3, 'user-a');

    expect(context).toContain('ich mag Orangensaft');
  });

  it('keeps canonical semantic queries natural and reserves variants for lexical fallback', async () => {
    const searchMemories = vi.fn(async () => [] as Mem0SearchHit[]);
    const listMemories = vi.fn(
      async (input: Mem0ListInput): Promise<Mem0ListMemoryResult> => ({
        memories: [],
        total: 0,
        page: input.page,
        pageSize: input.pageSize,
      }),
    );
    const service = new MemoryService({
      provider: 'postgres',
      searchMemories,
      listMemories,
    } as unknown as Mem0Client);

    await service.recallDetailed('persona-a', 'Was magst du?', 3, 'user-a');

    expect(searchMemories).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'Was magst du?' }),
    );
    expect(listMemories).toHaveBeenCalledWith(expect.objectContaining({ query: 'was mag ich?' }));
  });

  it('annotates first-person memories as assistant self-reference in recall context', async () => {
    const service = new MemoryService(createInMemoryMem0Client());
    await service.store('persona-a', 'preference', 'Ich mag Orangensaft', 4, 'user-a');

    const context = await service.recall('persona-a', 'orangensaft', 3, 'user-a');

    expect(context).toContain('[Type: preference] Ich mag Orangensaft');
    expect(context).toContain('[Subject: assistant');
  });

  it('keeps rule-related lexical memories when semantic search is noisy', async () => {
    const client = createInMemoryMem0Client();
    const service = new MemoryService(client);
    const ruleNode = await service.store(
      'persona-a',
      'fact',
      'Regeln: Immer puenktlich sein und freundlich bleiben.',
      4,
      'user-a',
    );
    const noisyNode = await service.store(
      'persona-a',
      'fact',
      'Allgemeine Einfuehrung ohne klaren Bezug.',
      3,
      'user-a',
    );

    client.searchMemories = async () => [
      {
        id: noisyNode.id,
        content: noisyNode.content,
        score: 0.95,
        metadata: noisyNode.metadata || {},
      },
      {
        id: ruleNode.id,
        content: ruleNode.content,
        score: 0.2,
        metadata: ruleNode.metadata || {},
      },
    ];

    const context = await service.recall('persona-a', 'Regeln', 3, 'user-a');
    expect(context).toContain('Regeln: Immer puenktlich sein');
  });

  it('returns paginated, filtered nodes for listPage', async () => {
    const service = new MemoryService(createInMemoryMem0Client());
    await service.store('persona-a', 'fact', 'alpha', 4, 'user-a');
    await service.store('persona-a', 'lesson', 'beta', 3, 'user-a');
    await service.store('persona-a', 'fact', 'gamma', 2, 'user-a');

    const firstPage = await service.listPage('persona-a', { page: 1, pageSize: 2 }, 'user-a');
    expect(firstPage.nodes).toHaveLength(2);
    expect(firstPage.pagination.total).toBe(3);

    const filtered = await service.listPage(
      'persona-a',
      { page: 1, pageSize: 10, type: 'fact', query: 'ga' },
      'user-a',
    );
    expect(filtered.nodes).toHaveLength(1);
    expect(filtered.nodes[0].content).toBe('gamma');
  });

  it('loads a bounded cross-scope preview without walking later pages', async () => {
    const client = createInMemoryMem0Client();
    const service = new MemoryService(client);
    await service.store('persona-a', 'fact', 'legacy memory', 3, 'user-a');
    await service.store('persona-a', 'fact', 'channel memory one', 3, 'user-b');
    await service.store('persona-a', 'lesson', 'channel memory two', 3, 'user-b');

    const listSpy = vi.spyOn(client, 'listMemories');
    const preview = await service.listPreviewAcrossScopes('persona-a', ['user-a', 'user-b'], 2);

    expect(preview.nodes).toHaveLength(2);
    expect(preview.truncated).toBe(true);
    expect(listSpy).toHaveBeenCalledTimes(2);
    expect(listSpy.mock.calls.every(([input]) => input.page === 1 && input.pageSize === 2)).toBe(
      true,
    );
  });

  it('builds a cross-scope page from the required prefix instead of full snapshots', async () => {
    const listMemories = vi.fn(async (input: Mem0ListInput): Promise<Mem0ListMemoryResult> => {
      const offset = (input.page - 1) * input.pageSize;
      return {
        memories: Array.from({ length: input.pageSize }, (_, index) => ({
          id: `${input.userId}-${offset + index}`,
          content: `memory ${input.userId} ${offset + index}`,
          score: null,
          metadata: {
            type: 'fact',
            lastVerified: new Date(Date.UTC(2026, 0, 1, 0, 0, offset + index)).toISOString(),
          },
        })),
        total: 10_000,
        page: input.page,
        pageSize: input.pageSize,
      };
    });
    const service = new MemoryService({
      provider: 'postgres',
      listMemories,
    } as unknown as Mem0Client);

    const result = await service.listPageAcrossScopes('persona-a', ['user-a', 'user-b', 'user-a'], {
      page: 2,
      pageSize: 25,
    });

    expect(result.nodes).toHaveLength(25);
    expect(result.pagination).toEqual({ page: 2, pageSize: 25, total: 20_000, totalPages: 800 });
    expect(listMemories).toHaveBeenCalledTimes(2);
    expect(
      listMemories.mock.calls.every(
        ([input]) => input.page === 1 && input.pageSize === 50 && input.personaId === 'persona-a',
      ),
    ).toBe(true);
  });

  it('returns memory count via lightweight first-page metadata lookup', async () => {
    const client = createInMemoryMem0Client();
    const service = new MemoryService(client);
    await service.store('persona-a', 'fact', 'alpha', 4, 'user-a');
    await service.store('persona-b', 'fact', 'beta', 3, 'user-a');

    const listSpy = vi.spyOn(client, 'listMemories');
    const count = await service.count(undefined, 'user-a');

    expect(count).toBe(2);
    expect(listSpy).toHaveBeenCalledTimes(1);
    expect(listSpy).toHaveBeenCalledWith({
      userId: 'user-a',
      personaId: undefined,
      page: 1,
      pageSize: 1,
    });
  });

  it('updates memory content/type/importance', async () => {
    const service = new MemoryService(createInMemoryMem0Client());
    const stored = await service.store('persona-a', 'fact', 'alpha', 2, 'user-a');

    const updated = await service.update(
      'persona-a',
      stored.id,
      { content: 'alpha-updated', type: 'lesson', importance: 5 },
      'user-a',
    );

    expect(updated).not.toBeNull();
    expect(updated?.id).toBe(stored.id);
    expect(updated?.content).toBe('alpha-updated');
    expect(updated?.type).toBe('lesson');
    expect(updated?.importance).toBe(5);
    expect(updated?.metadata?.version).toBe(2);
  });

  it('deletes a single memory node', async () => {
    const service = new MemoryService(createInMemoryMem0Client());
    const stored = await service.store('persona-a', 'fact', 'alpha', 2, 'user-a');

    const deleted = await service.delete('persona-a', stored.id, 'user-a');
    const snapshot = await service.snapshot('persona-a', 'user-a');

    expect(deleted).toBe(true);
    expect(snapshot).toHaveLength(0);
  });

  it('supports bulk update and bulk delete', async () => {
    const service = new MemoryService(createInMemoryMem0Client());
    const a = await service.store('persona-a', 'fact', 'a', 2, 'user-a');
    const b = await service.store('persona-a', 'preference', 'b', 3, 'user-a');

    const updated = await service.bulkUpdate(
      'persona-a',
      [a.id, b.id],
      { type: 'lesson' as MemoryType, importance: 5 },
      'user-a',
    );
    expect(updated).toBe(2);

    const afterUpdate = await service.snapshot('persona-a', 'user-a');
    expect(afterUpdate.every((node) => node.type === 'lesson')).toBe(true);
    expect(afterUpdate.every((node) => node.importance === 5)).toBe(true);

    const deleted = await service.bulkDelete('persona-a', [a.id, b.id], 'user-a');
    expect(deleted).toBe(2);
    const afterDelete = await service.snapshot('persona-a', 'user-a');
    expect(afterDelete).toHaveLength(0);
  });

  it('updates metadata feedback fields on positive feedback', async () => {
    const service = new MemoryService(createInMemoryMem0Client());
    const stored = await service.store('persona-a', 'fact', 'alpha', 2, 'user-a');

    const changed = await service.registerFeedback('persona-a', [stored.id], 'positive', 'user-a');
    expect(changed).toBe(1);

    const after = await service.snapshot('persona-a', 'user-a');
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(stored.id);
    expect(after[0].metadata?.lastFeedback).toBe('positive');
    expect(after[0].metadata?.feedbackCount).toBe(1);
    expect(after[0].metadata?.version).toBe(2);
  });

  it('returns history records after updates', async () => {
    const service = new MemoryService(createInMemoryMem0Client());
    const stored = await service.store('persona-a', 'fact', 'alpha', 2, 'user-a');
    await service.update(
      'persona-a',
      stored.id,
      { content: 'alpha-updated', type: 'lesson', importance: 5 },
      'user-a',
    );

    const history = await service.history('persona-a', stored.id, 'user-a');
    expect(history).not.toBeNull();
    expect(history?.node.id).toBe(stored.id);
    expect(history?.entries.length).toBeGreaterThanOrEqual(2);
    expect(history?.entries[0].action).toMatch(/create|update/);
    expect(history?.entries[1].action).toMatch(/create|update/);
  });

  it('rejects stale expectedVersion on update', async () => {
    const service = new MemoryService(createInMemoryMem0Client());
    const stored = await service.store('persona-a', 'fact', 'alpha', 2, 'user-a');

    await service.update('persona-a', stored.id, { content: 'alpha-v2' }, 'user-a');

    await expect(
      service.update(
        'persona-a',
        stored.id,
        {
          content: 'alpha-stale',
          expectedVersion: 1,
        } as unknown as { type?: MemoryType; content?: string; importance?: number },
        'user-a',
      ),
    ).rejects.toThrow(/version|conflict/i);
  });

  it('restores memory content from history index', async () => {
    const service = new MemoryService(createInMemoryMem0Client());
    const stored = await service.store('persona-a', 'fact', 'alpha', 2, 'user-a');
    await service.update(
      'persona-a',
      stored.id,
      { content: 'alpha-v2', type: 'lesson', importance: 5 },
      'user-a',
    );

    const restored = await (
      service as unknown as {
        restoreFromHistory: (
          personaId: string,
          nodeId: string,
          input: { restoreIndex: number; expectedVersion?: number },
          userId?: string,
        ) => Promise<MemoryNode | null>;
      }
    ).restoreFromHistory('persona-a', stored.id, { restoreIndex: 0, expectedVersion: 2 }, 'user-a');

    expect(restored).not.toBeNull();
    expect(restored?.content).toBe('alpha');
    expect(restored?.type).toBe('fact');
  });

  it('deletes all memories of one persona only', async () => {
    const service = new MemoryService(createInMemoryMem0Client());
    await service.store('persona-a', 'fact', 'alpha', 2, 'user-a');
    await service.store('persona-b', 'fact', 'beta', 2, 'user-a');

    const deleted = await service.deleteByPersona('persona-a', 'user-a');
    expect(deleted).toBe(1);

    const personaA = await service.snapshot('persona-a', 'user-a');
    const personaB = await service.snapshot('persona-b', 'user-a');
    expect(personaA).toHaveLength(0);
    expect(personaB).toHaveLength(1);
  });

  it('does not swallow generic HTTP 500 delete errors as not-found', async () => {
    const client = createInMemoryMem0Client();
    client.deleteMemory = async () => {
      throw new Error('Mem0 request failed with HTTP 500.');
    };
    const service = new MemoryService(client);
    const stored = await service.store('persona-a', 'fact', 'delete candidate', 3, 'user-a');

    await expect(service.delete('persona-a', stored.id, 'user-a')).rejects.toThrow(/HTTP 500/i);
  });

  it('treats known legacy delete 500 NoneType payload error as not-found', async () => {
    const client = createInMemoryMem0Client();
    client.deleteMemory = async () => {
      throw new Error(
        "Mem0 request failed with HTTP 500. 'NoneType' object has no attribute 'payload'",
      );
    };
    const service = new MemoryService(client);

    await expect(service.delete('persona-a', 'missing-node', 'user-a')).resolves.toBe(false);
  });

  it('keeps listPage total consistent when local filter removes non-matching rows', async () => {
    const client = createInMemoryMem0Client();
    client.listMemories = async (input) => {
      if (input.page > 1) {
        return { memories: [], total: 2, page: input.page, pageSize: 200 };
      }
      return {
        memories: [
          defaultRecord('m-1', {
            userId: 'user-a',
            personaId: 'persona-a',
            content: 'match-item',
            metadata: { type: 'fact', importance: 3, confidence: 0.3 },
          }),
          defaultRecord('m-2', {
            userId: 'user-a',
            personaId: 'persona-a',
            content: 'different-item',
            metadata: { type: 'fact', importance: 3, confidence: 0.3 },
          }),
        ],
        total: 2,
        page: 1,
        pageSize: 200,
      };
    };
    const service = new MemoryService(client);

    const result = await service.listPage(
      'persona-a',
      { page: 1, pageSize: 25, query: 'match' },
      'user-a',
    );

    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].content).toBe('match-item');
    expect(result.pagination.total).toBe(1);
    expect(result.pagination.totalPages).toBe(1);
  });

  it('merges legacy and channel scopes before slicing pagination', async () => {
    const client = createInMemoryMem0Client();
    await client.addMemory({
      userId: 'legacy-user',
      personaId: 'persona-a',
      content: 'legacy memory',
      metadata: { type: 'fact', importance: 3 },
    });
    await client.addMemory({
      userId: 'channel:telegram:chat-1',
      personaId: 'persona-a',
      content: 'channel memory one',
      metadata: { type: 'fact', importance: 3 },
    });
    await client.addMemory({
      userId: 'channel:telegram:chat-1',
      personaId: 'persona-a',
      content: 'channel memory two',
      metadata: { type: 'fact', importance: 3 },
    });
    const service = new MemoryService(client);

    const firstPage = await service.listPageAcrossScopes(
      'persona-a',
      ['legacy-user', 'channel:telegram:chat-1'],
      { page: 1, pageSize: 2 },
    );
    const secondPage = await service.listPageAcrossScopes(
      'persona-a',
      ['legacy-user', 'channel:telegram:chat-1'],
      { page: 2, pageSize: 2 },
    );

    expect(firstPage.nodes).toHaveLength(2);
    expect(secondPage.nodes).toHaveLength(1);
    expect(firstPage.pagination.total).toBe(3);
    expect(secondPage.pagination.totalPages).toBe(2);
    expect(new Set([...firstPage.nodes, ...secondPage.nodes].map((node) => node.content))).toEqual(
      new Set(['legacy memory', 'channel memory one', 'channel memory two']),
    );
  });

  it('reuses concurrent and previously stored memories with the same idempotency key', async () => {
    const client = createInMemoryMem0Client();
    const addMemory = vi.spyOn(client, 'addMemory');
    const service = new MemoryService(client);
    const input = {
      personaId: 'persona-a',
      type: 'fact' as const,
      content: 'one logical memory',
      importance: 4,
      userId: 'user-a',
      metadata: { idempotencyKey: 'request-42' },
    };

    const [first, concurrent] = await Promise.all([
      service.storeMemory(input),
      service.storeMemory(input),
    ]);
    const repeated = await service.storeMemory(input);

    expect(concurrent.id).toBe(first.id);
    expect(repeated.id).toBe(first.id);
    expect(addMemory).toHaveBeenCalledOnce();
  });

  it('uses scoped PostgreSQL reads and optimistic versions when updating lifecycle state', async () => {
    const initial = defaultRecord('postgres-memory', {
      userId: 'user-a',
      personaId: 'persona-a',
      workspaceId: 'workspace-a',
      content: 'before update',
      metadata: { type: 'fact', importance: 3, confidence: 0.8, version: 4 },
    });
    let persisted = initial;
    const getMemory = vi.fn(async () => persisted);
    const updateMemory = vi.fn(async (_id: string, input: Mem0MemoryInput) => {
      persisted = {
        ...persisted,
        content: input.content,
        metadata: input.metadata,
        updatedAt: '2026-10-08T10:00:00.000Z',
      };
    });
    const client = {
      provider: 'postgres',
      getMemory,
      updateMemory,
    } as unknown as Mem0Client;
    const service = new MemoryService(client);
    const events: Array<{ memoryId: string; status: string; signal: string }> = [];
    const unsubscribe = getServerEventBus().subscribe('memory.lifecycle.changed', (event) => {
      events.push({ memoryId: event.memoryId, status: event.status, signal: event.signal });
    });

    try {
      const updated = await service.update(
        'persona-a',
        'postgres-memory',
        {
          content: 'after update',
          expectedVersion: 4,
          metadata: { lifecycleSignal: 'user_confirmed' },
        },
        'user-a',
        'workspace-a',
      );

      expect(updated).toMatchObject({ content: 'after update', metadata: { version: 5 } });
    } finally {
      unsubscribe();
    }

    expect(getMemory).toHaveBeenCalledTimes(2);
    expect(getMemory).toHaveBeenCalledWith('postgres-memory', {
      userId: 'user-a',
      personaId: 'persona-a',
      workspaceId: 'workspace-a',
    });
    expect(updateMemory).toHaveBeenCalledWith(
      'postgres-memory',
      expect.objectContaining({
        content: 'after update',
        metadata: expect.objectContaining({
          expectedVersion: 4,
          version: 5,
          memoryProvider: 'postgres',
        }),
      }),
      expect.objectContaining({ workspaceId: 'workspace-a' }),
    );
    expect(events).toContainEqual({
      memoryId: 'postgres-memory',
      status: 'new',
      signal: 'user_confirmed',
    });
  });

  it('returns no update for an unowned PostgreSQL memory', async () => {
    const getMemory = vi.fn(async () => null);
    const updateMemory = vi.fn();
    const service = new MemoryService({
      provider: 'postgres',
      getMemory,
      updateMemory,
    } as unknown as Mem0Client);

    await expect(
      service.update('persona-a', 'other-user-memory', { content: 'change' }, 'user-a'),
    ).resolves.toBeNull();
    expect(updateMemory).not.toHaveBeenCalled();
  });

  it('uses returned totals only when finite and falls back to rows for legacy providers', async () => {
    const row = defaultRecord('listed-memory', {
      userId: 'user-a',
      personaId: 'persona-a',
      content: 'listed memory',
      metadata: { type: 'fact', importance: 3 },
    });
    const service = new MemoryService({
      listMemories: async (input: Mem0ListInput) => ({
        memories: [row],
        total: Number.NaN,
        page: input.page,
        pageSize: input.pageSize,
      }),
    } as unknown as Mem0Client);

    await expect(service.count('persona-a', 'user-a')).resolves.toBe(1);
    await expect(service.snapshot('persona-a', 'user-a')).resolves.toMatchObject([
      { id: 'listed-memory', content: 'listed memory' },
    ]);
  });

  it('deduplicates overlapping preview scopes and keeps the newest record', async () => {
    const recordsByUser: Record<string, Mem0MemoryRecord[]> = {
      'user-a': [
        defaultRecord('shared', {
          userId: 'user-a',
          personaId: 'persona-a',
          content: 'older copy',
          metadata: { type: 'fact', lastVerified: timestampAtMinute(1) },
        }),
        defaultRecord('a-memory', {
          userId: 'user-a',
          personaId: 'persona-a',
          content: 'alpha',
          metadata: { type: 'fact', lastVerified: timestampAtMinute(3) },
        }),
      ],
      'user-b': [
        defaultRecord('shared', {
          userId: 'user-b',
          personaId: 'persona-a',
          content: 'newer copy',
          metadata: { type: 'fact', lastVerified: timestampAtMinute(2) },
        }),
        defaultRecord('b-memory', {
          userId: 'user-b',
          personaId: 'persona-a',
          content: 'beta',
          metadata: { type: 'fact', lastVerified: 'invalid timestamp' },
        }),
      ],
    };
    const service = new MemoryService({
      listMemories: async (input: Mem0ListInput) => ({
        memories: recordsByUser[input.userId] || [],
        total: (recordsByUser[input.userId] || []).length,
        page: input.page,
        pageSize: input.pageSize,
      }),
    } as unknown as Mem0Client);

    const preview = await service.listPreviewAcrossScopes('persona-a', ['user-a', 'user-b'], 3);

    expect(preview.nodes.map((node) => node.id)).toEqual(['a-memory', 'shared', 'b-memory']);
    expect(preview.nodes[1]?.content).toBe('newer copy');
    expect(preview.truncated).toBe(false);
  });

  it('handles missing history, not-found history responses, and invalid restore entries', async () => {
    const client = createInMemoryMem0Client();
    const service = new MemoryService(client);

    await expect(service.history('persona-a', 'missing', 'user-a')).resolves.toBeNull();
    await expect(
      service.restoreFromHistory('persona-a', 'missing', { restoreIndex: 0 }, 'user-a'),
    ).resolves.toBeNull();

    const stored = await service.store('persona-a', 'fact', 'current content', 3, 'user-a');
    const history = vi.spyOn(client, 'getMemoryHistory');
    history.mockRejectedValueOnce(new Error('Mem0 request failed with HTTP 404.'));
    await expect(service.history('persona-a', stored.id, 'user-a')).resolves.toMatchObject({
      entries: [],
    });

    history.mockResolvedValueOnce([{ action: 'update', content: '  ', metadata: {}, raw: {} }]);
    await expect(
      service.restoreFromHistory('persona-a', stored.id, { restoreIndex: 0 }, 'user-a'),
    ).rejects.toThrow('no restorable content');

    history.mockResolvedValueOnce([
      { action: 'update', content: 'older content', metadata: {}, raw: {} },
    ]);
    await expect(
      service.restoreFromHistory('persona-a', stored.id, { restoreIndex: 1 }, 'user-a'),
    ).rejects.toThrow('Invalid restore index');

    history.mockRejectedValueOnce(new Error('Mem0 request failed with HTTP 500.'));
    await expect(service.history('persona-a', stored.id, 'user-a')).rejects.toThrow('HTTP 500');
  });

  it('recovers from a legacy delete 404 by retrying the rewritten node id', async () => {
    const client = createInMemoryMem0Client();
    const service = new MemoryService(client);
    const stored = await service.store('persona-a', 'fact', 'legacy deletion', 3, 'user-a');
    const deleteMemory = vi.spyOn(client, 'deleteMemory');
    deleteMemory.mockImplementationOnce(async () => {
      throw new Error('Mem0 request failed with HTTP 404.');
    });

    await expect(service.delete('persona-a', stored.id, 'user-a')).resolves.toBe(true);
    expect(deleteMemory).toHaveBeenCalledTimes(2);
  });

  it('returns false when a legacy delete cannot find or retry the rewritten record', async () => {
    const client = createInMemoryMem0Client();
    const service = new MemoryService(client);
    const aliased = await client.addMemory({
      userId: 'user-a',
      personaId: 'persona-a',
      content: 'legacy alias',
      metadata: { type: 'fact', mem0Id: 'different-source-id' },
    });
    const deleteMemory = vi
      .spyOn(client, 'deleteMemory')
      .mockRejectedValue(new Error('Mem0 request failed with HTTP 404.'));

    await expect(service.delete('persona-a', aliased.id!, 'user-a')).resolves.toBe(false);
    expect(deleteMemory).toHaveBeenCalledOnce();
  });

  it('uses the provider count endpoint and reads all reported snapshot pages', async () => {
    const records = [
      defaultRecord('page-one', {
        userId: 'user-a',
        personaId: 'persona-a',
        content: 'first page memory',
        metadata: { type: 'fact', importance: 3 },
      }),
      defaultRecord('page-two', {
        userId: 'user-a',
        personaId: 'persona-a',
        content: 'second page memory',
        metadata: { type: 'fact', importance: 3 },
      }),
    ];
    const countMemories = vi.fn(async () => 2);
    const listMemories = vi.fn(
      async (input: Mem0ListInput): Promise<Mem0ListMemoryResult> => ({
        memories: input.page === 1 ? [records[0]!] : [records[1]!],
        total: 2,
        page: input.page,
        pageSize: input.pageSize,
      }),
    );
    const service = new MemoryService({
      provider: 'mem0',
      countMemories,
      listMemories,
    } as unknown as Mem0Client);

    await expect(service.count('persona-a', 'user-a')).resolves.toBe(2);
    await expect(service.snapshot('persona-a', 'user-a')).resolves.toMatchObject([
      { id: 'page-one', content: 'first page memory' },
      { id: 'page-two', content: 'second page memory' },
    ]);

    expect(countMemories).toHaveBeenCalledWith({
      userId: 'user-a',
      personaId: 'persona-a',
      workspaceId: undefined,
    });
    expect(listMemories.mock.calls.map(([input]) => input.page)).toEqual([1, 2]);
  });

  it('deduplicates concurrent updates and derives a missing version from history', async () => {
    const current = defaultRecord('legacy-version', {
      userId: 'user-a',
      personaId: 'persona-a',
      content: 'before',
      metadata: { type: 'fact', importance: 3, confidence: 0.8 },
    });
    const getMemory = vi.fn(async () => current);
    const getMemoryHistory = vi.fn(async () => [
      { action: 'create', content: 'before', metadata: {}, raw: {} },
      { action: 'update', content: 'before', metadata: {}, raw: {} },
    ]);
    let releaseUpdate: (() => void) | undefined;
    const updateGate = new Promise<void>((resolve) => {
      releaseUpdate = resolve;
    });
    const updateMemory = vi.fn(async () => updateGate);
    const service = new MemoryService({
      provider: 'postgres',
      getMemory,
      getMemoryHistory,
      updateMemory,
    } as unknown as Mem0Client);

    const first = service.update('persona-a', current.id!, { content: 'after' }, 'user-a');
    await vi.waitFor(() => expect(getMemory).toHaveBeenCalledOnce());
    const concurrent = service.update('persona-a', current.id!, { content: 'ignored' }, 'user-a');
    releaseUpdate?.();
    const [updated, shared] = await Promise.all([first, concurrent]);

    expect(updated).toEqual(shared);
    expect(updated).toMatchObject({ content: 'after', metadata: { version: 3 } });
    expect(getMemory).toHaveBeenCalledOnce();
    expect(getMemoryHistory).toHaveBeenCalledOnce();
    expect(updateMemory).toHaveBeenCalledOnce();
  });

  it('uses the finite fallback page size and preserves the newest duplicate across preview scopes', async () => {
    const newest = defaultRecord('shared-preview', {
      userId: 'user-a',
      personaId: 'persona-a',
      content: 'newest copy',
      metadata: { type: 'fact', lastVerified: timestampAtMinute(2) },
    });
    const older = defaultRecord('shared-preview', {
      userId: 'user-b',
      personaId: 'persona-a',
      content: 'older copy',
      metadata: { type: 'fact', lastVerified: timestampAtMinute(1) },
    });
    const listMemories = vi.fn(
      async (input: Mem0ListInput): Promise<Mem0ListMemoryResult> => ({
        memories: [input.userId === 'user-a' ? newest : older],
        total: 1,
        page: input.page,
        pageSize: input.pageSize,
      }),
    );
    const service = new MemoryService({ listMemories } as unknown as Mem0Client);

    const preview = await service.listPreviewAcrossScopes(
      'persona-a',
      [' user-a ', 'user-b', 'user-a', '  '],
      Number.NaN,
    );

    expect(preview.nodes).toHaveLength(1);
    expect(preview.nodes[0]).toMatchObject({ id: 'shared-preview', content: 'newest copy' });
    expect(preview.truncated).toBe(false);
    expect(listMemories).toHaveBeenCalledTimes(2);
    expect(listMemories.mock.calls.every(([input]) => input.pageSize === 50)).toBe(true);
  });

  it('rejects restoring an empty history entry before writing it', async () => {
    const client = createInMemoryMem0Client();
    const service = new MemoryService(client);
    const stored = await service.store('persona-a', 'fact', 'current content', 3, 'user-a');
    const updateMemory = vi.spyOn(client, 'updateMemory');
    vi.spyOn(client, 'getMemoryHistory').mockResolvedValueOnce([
      { action: 'update', content: '', metadata: {}, raw: {} },
    ]);

    await expect(
      service.restoreFromHistory('persona-a', stored.id, { restoreIndex: 0 }, 'user-a'),
    ).rejects.toThrow('no restorable content');
    expect(updateMemory).not.toHaveBeenCalled();
  });
});
