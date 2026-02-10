import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { MemoryNode } from '../../../core/memory/types';
import { SqliteMemoryRepository } from '../../../src/server/memory/sqliteMemoryRepository';

function createNode(overrides: Partial<MemoryNode> = {}): MemoryNode {
  return {
    id: 'mem-1',
    type: 'fact',
    content: 'Persistent memory entry',
    embedding: [0.1, 0.2, 0.3],
    importance: 3,
    confidence: 0.3,
    timestamp: '10:00',
    metadata: { source: 'test' },
    ...overrides,
  };
}

describe('SqliteMemoryRepository', () => {
  let dbPath = '';

  beforeEach(() => {
    dbPath = path.join(
      process.cwd(),
      '.local',
      `memory.sqlite-repository.${Date.now()}.${Math.random().toString(36).slice(2)}.db`,
    );
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  it('creates table and returns empty list initially', () => {
    const repo = new SqliteMemoryRepository(dbPath);
    expect(repo.listNodes()).toEqual([]);
  });

  it('inserts and lists memory nodes with JSON fields restored', () => {
    const repo = new SqliteMemoryRepository(dbPath);
    repo.insertNode(createNode());

    const nodes = repo.listNodes();
    expect(nodes).toHaveLength(1);
    expect(nodes[0].embedding).toEqual([0.1, 0.2, 0.3]);
    expect(nodes[0].metadata?.source).toBe('test');
  });

  it('updates an existing memory node', () => {
    const repo = new SqliteMemoryRepository(dbPath);
    repo.insertNode(createNode());
    repo.updateNode(
      createNode({
        confidence: 0.8,
        importance: 5,
        metadata: { lastVerified: '2026-02-10T12:00:00.000Z' },
      }),
    );

    const updated = repo.listNodes()[0];
    expect(updated.confidence).toBe(0.8);
    expect(updated.importance).toBe(5);
    expect(updated.metadata?.lastVerified).toBe('2026-02-10T12:00:00.000Z');
  });

  it('persists records across repository instances', () => {
    const first = new SqliteMemoryRepository(dbPath);
    first.insertNode(createNode({ id: 'mem-persist' }));

    const second = new SqliteMemoryRepository(dbPath);
    const nodes = second.listNodes();
    expect(nodes).toHaveLength(1);
    expect(nodes[0].id).toBe('mem-persist');
  });
});
