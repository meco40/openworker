import { describe, expect, it } from 'vitest';
import type { MemoryNode, MemoryType } from '@/core/memory/types';
import type {
  Mem0Client,
  Mem0ListInput,
  Mem0ListMemoryResult,
  Mem0MemoryInput,
  Mem0MemoryRecord,
  Mem0SearchHit,
  Mem0SearchInput,
} from '@/server/memory/mem0Client';
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

    await expect(service.delete('persona-a', 'missing-node', 'user-a')).rejects.toThrow(
      /HTTP 500/i,
    );
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
    client.listMemories = async () => ({
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
      total: 999,
      page: 1,
      pageSize: 25,
    });
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
});
