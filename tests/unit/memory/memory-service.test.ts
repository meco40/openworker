import { describe, expect, it } from 'vitest';
import type { MemoryNode } from '../../../core/memory/types';
import type { MemoryRepository } from '../../../src/server/memory/repository';
import { MemoryService } from '../../../src/server/memory/service';

function createRepository(initialNodes: MemoryNode[] = []): MemoryRepository {
  let nodes = [...initialNodes];
  return {
    listNodes: () => [...nodes],
    insertNode: (node) => {
      nodes.push(node);
    },
    updateNode: (node) => {
      nodes = nodes.map((existing) => (existing.id === node.id ? node : existing));
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

    const first = await service.store('fact', 'alpha', 2);
    const second = await service.store('fact', 'alpha', 5);

    expect(second.id).toBe(first.id);
    expect(second.importance).toBe(5);
    expect(second.confidence).toBeGreaterThan(first.confidence);
    expect(repo.listNodes()).toHaveLength(1);
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

    const context = await service.recall('query', 3);

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

    const context = await service.recall('query', 3);
    expect(context).toBe('No relevant memories found.');
  });
});
