import { describe, expect, it } from 'vitest';
import type { MemoryNode } from '../../../core/memory/types';
import type { MemoryRepository } from '../../../src/server/memory/repository';
import { MemoryService } from '../../../src/server/memory/service';
import type { Mem0Client } from '../../../src/server/memory/mem0Client';

function scopeKey(personaId: string, userId?: string): string {
  return `${userId || 'legacy-local-user'}::${personaId}`;
}

function createRepository(initialNodes: MemoryNode[] = []): MemoryRepository {
  const byScope = new Map<string, MemoryNode[]>();
  byScope.set(scopeKey('persona-test'), [...initialNodes]);

  const read = (personaId: string, userId?: string): MemoryNode[] => byScope.get(scopeKey(personaId, userId)) || [];
  const write = (personaId: string, nodes: MemoryNode[], userId?: string): void => {
    byScope.set(scopeKey(personaId, userId), nodes);
  };
  const readAll = (userId?: string): MemoryNode[] => {
    if (!userId) return Array.from(byScope.values()).flat();
    const prefix = `${userId}::`;
    return Array.from(byScope.entries())
      .filter(([key]) => key.startsWith(prefix))
      .flatMap(([, value]) => value);
  };

  return {
    listNodes: (personaId, userId) => [...read(personaId, userId)],
    listNodesPage: (personaId, input, userId) => {
      const page = Math.max(1, Math.floor(input.page));
      const pageSize = Math.max(1, Math.floor(input.pageSize));
      const all = read(personaId, userId);
      const start = (page - 1) * pageSize;
      return {
        nodes: all.slice(start, start + pageSize),
        total: all.length,
      };
    },
    listAllNodes: (userId) => readAll(userId),
    insertNode: (personaId, node, userId) => {
      write(personaId, [...read(personaId, userId), node], userId);
    },
    updateNode: (personaId, node, userId) => {
      write(
        personaId,
        read(personaId, userId).map((existing) => (existing.id === node.id ? node : existing)),
        userId,
      );
    },
    deleteNode: (personaId, nodeId, userId) => {
      const before = read(personaId, userId);
      const after = before.filter((node) => node.id !== nodeId);
      write(personaId, after, userId);
      return before.length - after.length;
    },
    updateMany: (personaId, nodeIds, updates, userId) => {
      const ids = new Set(nodeIds);
      let changes = 0;
      write(
        personaId,
        read(personaId, userId).map((node) => {
          if (!ids.has(node.id)) return node;
          changes += 1;
          return {
            ...node,
            type: updates.type ?? node.type,
            importance: updates.importance ?? node.importance,
          };
        }),
        userId,
      );
      return changes;
    },
    deleteMany: (personaId, nodeIds, userId) => {
      const ids = new Set(nodeIds);
      const before = read(personaId, userId);
      const after = before.filter((node) => !ids.has(node.id));
      write(personaId, after, userId);
      return before.length - after.length;
    },
    deleteByPersona: (personaId, userId) => {
      const size = read(personaId, userId).length;
      byScope.delete(scopeKey(personaId, userId));
      return size;
    },
  };
}

function createNode(overrides: Partial<MemoryNode> = {}): MemoryNode {
  return {
    id: 'mem-node',
    type: 'fact',
    content: 'default',
    embedding: [0, 0],
    importance: 3,
    confidence: 0.3,
    timestamp: '10:00',
    metadata: {},
    ...overrides,
  };
}

describe('MemoryService', () => {
  it('reinforces duplicate memory instead of creating a second node', async () => {
    const repo = createRepository();
    const vectors: Record<string, number[]> = {
      alpha: [1, 0],
    };
    const service = new MemoryService(repo, async (text) => vectors[text] || [0, 0]);

    const first = await service.store('persona-test', 'fact', 'alpha', 2);
    const second = await service.store('persona-test', 'fact', 'alpha', 5);

    expect(second.id).toBe(first.id);
    expect(second.importance).toBe(5);
    expect(second.confidence).toBeGreaterThan(first.confidence);
    expect(repo.listNodes('persona-test')).toHaveLength(1);
  });

  it('keeps memories isolated per persona', async () => {
    const repo = createRepository();
    const vectors: Record<string, number[]> = {
      alpha: [1, 0],
    };
    const service = new MemoryService(repo, async (text) => vectors[text] || [0, 0]);

    const first = await service.store('persona-a', 'fact', 'alpha', 2);
    const second = await service.store('persona-b', 'fact', 'alpha', 5);

    expect(second.id).not.toBe(first.id);
    expect(repo.listNodes('persona-a')).toHaveLength(1);
    expect(repo.listNodes('persona-b')).toHaveLength(1);
  });

  it('returns ranked recall context with threshold filtering', async () => {
    const repo = createRepository([
      createNode({
        id: 'a',
        type: 'fact',
        content: 'alpha',
        embedding: [1, 0],
        confidence: 0.3,
      }),
      createNode({
        id: 'b',
        type: 'preference',
        content: 'beta',
        embedding: [0.8, 0.6],
        confidence: 1.0,
      }),
      createNode({
        id: 'c',
        type: 'lesson',
        content: 'gamma',
        embedding: [0, 1],
        confidence: 1.0,
      }),
    ]);
    const service = new MemoryService(repo, async (text) => (text === 'query' ? [1, 0] : [0, 0]));

    const context = await service.recall('persona-test', 'query', 3);

    expect(context).toContain('[Type: preference] beta');
    expect(context).toContain('[Type: fact] alpha');
    expect(context).not.toContain('gamma');
    expect(context.indexOf('beta')).toBeLessThan(context.indexOf('alpha'));
  });

  it('returns fallback text when no memory passes similarity threshold', async () => {
    const repo = createRepository([
      createNode({
        id: 'x',
        type: 'fact',
        content: 'low-similarity',
        embedding: [0, 1],
      }),
    ]);
    const service = new MemoryService(repo, async () => [1, 0]);

    const context = await service.recall('persona-test', 'query', 3);
    expect(context).toBe('No relevant memories found.');
  });

  it('returns recall metadata with node ids and scores', async () => {
    const repo = createRepository([
      createNode({
        id: 'a',
        type: 'fact',
        content: 'alpha',
        embedding: [1, 0],
        confidence: 0.8,
      }),
      createNode({
        id: 'b',
        type: 'lesson',
        content: 'beta',
        embedding: [0, 1],
        confidence: 0.9,
      }),
    ]);
    const service = new MemoryService(repo, async () => [1, 0]);

    const result = await service.recallDetailed('persona-test', 'query', 3);

    expect(result.context).toContain('alpha');
    expect(result.matches[0]?.node.id).toBe('a');
    expect(result.matches[0]?.score).toBeGreaterThan(0.7);
  });

  it('updates confidence and importance based on feedback signals', () => {
    const repo = createRepository([
      createNode({
        id: 'a',
        type: 'fact',
        content: 'alpha',
        embedding: [1, 0],
        importance: 3,
        confidence: 0.5,
      }),
    ]);
    const service = new MemoryService(repo, async () => [1, 0]);

    const positiveChanges = service.registerFeedback('persona-test', ['a'], 'positive');
    expect(positiveChanges).toBe(1);

    const afterPositive = repo.listNodes('persona-test').find((node) => node.id === 'a');
    expect(afterPositive?.importance).toBe(4);
    expect(afterPositive?.confidence).toBeGreaterThan(0.5);
    expect(afterPositive?.metadata?.lastFeedback).toBe('positive');

    const negativeChanges = service.registerFeedback('persona-test', ['a'], 'negative');
    expect(negativeChanges).toBe(1);
    const afterNegative = repo.listNodes('persona-test').find((node) => node.id === 'a');
    expect(afterNegative?.importance).toBe(3);
    expect(afterNegative?.metadata?.feedbackCount).toBe(2);
  });

  it('keeps memories isolated by user scope even for the same persona id', async () => {
    const repo = createRepository();
    const vectors: Record<string, number[]> = {
      alpha: [1, 0],
    };
    const service = new MemoryService(repo, async (text) => vectors[text] || [0, 0]);

    await service.store('persona-shared', 'fact', 'alpha', 3, 'user-a');
    await service.store('persona-shared', 'fact', 'alpha', 3, 'user-b');

    const userA = service.snapshot('persona-shared', 'user-a');
    const userB = service.snapshot('persona-shared', 'user-b');
    expect(userA).toHaveLength(1);
    expect(userB).toHaveLength(1);
    expect(userA[0].id).not.toBe(userB[0].id);
  });

  it('forgets repeatedly rejected memory nodes after sustained negative feedback', () => {
    const repo = createRepository([
      createNode({
        id: 'forget-me',
        type: 'fact',
        content: 'old incorrect memory',
        embedding: [1, 0],
        importance: 2,
        confidence: 0.25,
        metadata: { feedbackCount: 2, lastFeedback: 'negative' },
      }),
    ]);
    const service = new MemoryService(repo, async () => [1, 0]);

    const changed = service.registerFeedback('persona-test', ['forget-me'], 'negative');
    expect(changed).toBe(1);
    expect(service.snapshot('persona-test')).toHaveLength(0);
  });

  it('attaches mem0 id metadata when mem0 add succeeds', async () => {
    const repo = createRepository();
    const mem0: Mem0Client = {
      addMemory: async () => ({ id: 'mem0-1' }),
      searchMemories: async () => [],
      updateMemory: async () => {},
      deleteMemory: async () => {},
    };
    const service = new MemoryService(repo, async () => [1, 0], mem0);

    const stored = await service.store('persona-test', 'fact', 'alpha', 4, 'user-1');

    expect(stored.metadata?.mem0Id).toBe('mem0-1');
  });

  it('fails store when mem0 add fails instead of writing local fallback memory', async () => {
    const repo = createRepository();
    const mem0: Mem0Client = {
      addMemory: async () => {
        throw new Error('mem0 add failed');
      },
      searchMemories: async () => [],
      updateMemory: async () => {},
      deleteMemory: async () => {},
    };
    const service = new MemoryService(repo, async () => [1, 0], mem0);

    await expect(service.store('persona-test', 'fact', 'alpha', 4, 'user-1')).rejects.toThrow(/mem0 add failed/i);
    expect(service.snapshot('persona-test', 'user-1')).toHaveLength(0);
  });

  it('uses mem0 search first for recall and mirrors external ids locally', async () => {
    const repo = createRepository();
    const mem0: Mem0Client = {
      addMemory: async () => ({ id: 'mem0-1' }),
      searchMemories: async () => [
        {
          id: 'mem0-77',
          content: 'User likes oat milk.',
          score: 0.93,
          metadata: { type: 'preference', importance: 5 },
        },
      ],
      updateMemory: async () => {},
      deleteMemory: async () => {},
    };
    const service = new MemoryService(repo, async () => [1, 0], mem0);

    const recalled = await service.recallDetailed('persona-test', 'What milk do I prefer?', 3, 'user-1');
    const snapshot = service.snapshot('persona-test', 'user-1');

    expect(recalled.context).toContain('oat milk');
    expect(snapshot.some((node) => node.metadata?.mem0Id === 'mem0-77')).toBe(true);
  });

  it('throws when mem0 search fails and fallback recall is disabled', async () => {
    const repo = createRepository([
      createNode({
        id: 'local-1',
        type: 'fact',
        content: 'local fallback',
        embedding: [1, 0],
      }),
    ]);
    const mem0: Mem0Client = {
      addMemory: async () => ({ id: 'mem0-1' }),
      searchMemories: async () => {
        throw new Error('mem0 offline');
      },
      updateMemory: async () => {},
      deleteMemory: async () => {},
    };
    const service = new MemoryService(repo, async (text) => (text === 'query' ? [1, 0] : [0, 0]), mem0);

    await expect(service.recall('persona-test', 'query', 3)).rejects.toThrow(/mem0 offline/i);
  });

  it('does not use local similarity fallback when mem0 returns no hits', async () => {
    const repo = createRepository([
      createNode({
        id: 'local-1',
        type: 'fact',
        content: 'local fallback',
        embedding: [1, 0],
      }),
    ]);
    const mem0: Mem0Client = {
      addMemory: async () => ({ id: 'mem0-1' }),
      searchMemories: async () => [],
      updateMemory: async () => {},
      deleteMemory: async () => {},
    };
    const service = new MemoryService(repo, async (text) => (text === 'query' ? [1, 0] : [0, 0]), mem0);

    const context = await service.recall('persona-test', 'query', 3);
    expect(context).toBe('No relevant memories found.');
  });
});
