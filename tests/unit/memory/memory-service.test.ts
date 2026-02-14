import { describe, expect, it } from 'vitest';
import type { MemoryNode } from '../../../core/memory/types';
import type { MemoryRepository } from '../../../src/server/memory/repository';
import { MemoryService } from '../../../src/server/memory/service';

function createRepository(initialNodes: MemoryNode[] = []): MemoryRepository {
  const byPersona = new Map<string, MemoryNode[]>();
  byPersona.set('persona-test', [...initialNodes]);

  const read = (personaId: string): MemoryNode[] => byPersona.get(personaId) || [];

  return {
    listNodes: (personaId) => [...read(personaId)],
    listNodesPage: (personaId, input) => {
      const page = Math.max(1, Math.floor(input.page));
      const pageSize = Math.max(1, Math.floor(input.pageSize));
      const all = read(personaId);
      const start = (page - 1) * pageSize;
      return {
        nodes: all.slice(start, start + pageSize),
        total: all.length,
      };
    },
    listAllNodes: () => Array.from(byPersona.values()).flat(),
    insertNode: (personaId, node) => {
      byPersona.set(personaId, [...read(personaId), node]);
    },
    updateNode: (personaId, node) => {
      byPersona.set(
        personaId,
        read(personaId).map((existing) => (existing.id === node.id ? node : existing)),
      );
    },
    deleteNode: (personaId, nodeId) => {
      const before = read(personaId);
      const after = before.filter((node) => node.id !== nodeId);
      byPersona.set(personaId, after);
      return before.length - after.length;
    },
    updateMany: (personaId, nodeIds, updates) => {
      const ids = new Set(nodeIds);
      let changes = 0;
      byPersona.set(
        personaId,
        read(personaId).map((node) => {
          if (!ids.has(node.id)) return node;
          changes += 1;
          return {
            ...node,
            type: updates.type ?? node.type,
            importance: updates.importance ?? node.importance,
          };
        }),
      );
      return changes;
    },
    deleteMany: (personaId, nodeIds) => {
      const ids = new Set(nodeIds);
      const before = read(personaId);
      const after = before.filter((node) => !ids.has(node.id));
      byPersona.set(personaId, after);
      return before.length - after.length;
    },
    deleteByPersona: (personaId) => {
      const size = read(personaId).length;
      byPersona.delete(personaId);
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
});
