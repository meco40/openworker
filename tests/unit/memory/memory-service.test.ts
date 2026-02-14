import { describe, expect, it } from 'vitest';
import type { MemoryType } from '../../../core/memory/types';
import type {
  Mem0Client,
  Mem0ListInput,
  Mem0ListMemoryResult,
  Mem0MemoryInput,
  Mem0MemoryRecord,
  Mem0SearchHit,
  Mem0SearchInput,
} from '../../../src/server/memory/mem0Client';
import { MemoryService } from '../../../src/server/memory/service';

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

  const readScope = (userId: string, personaId: string): Mem0MemoryRecord[] =>
    byScope.get(scopeKey(userId, personaId)) || [];

  const writeScope = (userId: string, personaId: string, rows: Mem0MemoryRecord[]) => {
    byScope.set(scopeKey(userId, personaId), rows);
  };

  const findById = (id: string): { key: string; index: number; record: Mem0MemoryRecord } | null => {
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
      const next = [...readScope(input.userId, input.personaId), defaultRecord(id, input)];
      writeScope(input.userId, input.personaId, next);
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

  it('recalls relevant context via mem0 search results', async () => {
    const service = new MemoryService(createInMemoryMem0Client());
    await service.store('persona-a', 'preference', 'prefers oat milk', 4, 'user-a');

    const context = await service.recall('persona-a', 'oat', 3, 'user-a');

    expect(context).toContain('[Type: preference] prefers oat milk');
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
    expect(updated?.content).toBe('alpha-updated');
    expect(updated?.type).toBe('lesson');
    expect(updated?.importance).toBe(5);
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
    expect(after[0].metadata?.lastFeedback).toBe('positive');
    expect(after[0].metadata?.feedbackCount).toBe(1);
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
});
