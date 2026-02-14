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
  const personaA = 'persona-a';
  const personaB = 'persona-b';

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
    expect(repo.listNodes(personaA)).toEqual([]);
  });

  it('inserts and lists memory nodes with JSON fields restored', () => {
    const repo = new SqliteMemoryRepository(dbPath);
    repo.insertNode(personaA, createNode());

    const nodes = repo.listNodes(personaA);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].embedding).toEqual([0.1, 0.2, 0.3]);
    expect(nodes[0].metadata?.source).toBe('test');
  });

  it('updates an existing memory node', () => {
    const repo = new SqliteMemoryRepository(dbPath);
    repo.insertNode(personaA, createNode());
    repo.updateNode(
      personaA,
      createNode({
        confidence: 0.8,
        importance: 5,
        metadata: { lastVerified: '2026-02-10T12:00:00.000Z' },
      }),
    );

    const updated = repo.listNodes(personaA)[0];
    expect(updated.confidence).toBe(0.8);
    expect(updated.importance).toBe(5);
    expect(updated.metadata?.lastVerified).toBe('2026-02-10T12:00:00.000Z');
  });

  it('persists records across repository instances', () => {
    const first = new SqliteMemoryRepository(dbPath);
    first.insertNode(personaA, createNode({ id: 'mem-persist' }));

    const second = new SqliteMemoryRepository(dbPath);
    const nodes = second.listNodes(personaA);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].id).toBe('mem-persist');
  });

  it('isolates memory by persona and supports cascade delete by persona', () => {
    const repo = new SqliteMemoryRepository(dbPath);
    repo.insertNode(personaA, createNode({ id: 'mem-a' }));
    repo.insertNode(personaB, createNode({ id: 'mem-b' }));

    expect(repo.listNodes(personaA)).toHaveLength(1);
    expect(repo.listNodes(personaB)).toHaveLength(1);

    const deleted = repo.deleteByPersona(personaA);
    expect(deleted).toBe(1);
    expect(repo.listNodes(personaA)).toHaveLength(0);
    expect(repo.listNodes(personaB)).toHaveLength(1);
  });

  it('returns storage breakdown by type and largest nodes', () => {
    const repo = new SqliteMemoryRepository(dbPath);
    repo.insertNode(
      personaA,
      createNode({
        id: 'fact-large',
        type: 'fact',
        content: 'A'.repeat(300),
        embedding: Array.from({ length: 128 }, (_, idx) => idx / 100),
      }),
    );
    repo.insertNode(
      personaA,
      createNode({
        id: 'pref-medium',
        type: 'preference',
        content: 'B'.repeat(150),
        embedding: Array.from({ length: 64 }, (_, idx) => idx / 100),
      }),
    );

    const snapshot = repo.getStorageSnapshot(1);

    expect(snapshot.summary.totalNodes).toBe(2);
    expect(snapshot.summary.totalBytes).toBeGreaterThan(0);
    expect(snapshot.byType.some((row) => row.type === 'fact')).toBe(true);
    expect(snapshot.byType.some((row) => row.type === 'preference')).toBe(true);
    expect(snapshot.largestNodes).toHaveLength(1);
    expect(snapshot.largestNodes[0].id).toBe('fact-large');
  });

  it('supports paginated listing, bulk update, and bulk delete', () => {
    const repo = new SqliteMemoryRepository(dbPath);
    repo.insertNode(personaA, createNode({ id: 'p1', content: 'alpha', type: 'fact' }));
    repo.insertNode(personaA, createNode({ id: 'p2', content: 'beta', type: 'preference' }));
    repo.insertNode(personaA, createNode({ id: 'p3', content: 'gamma', type: 'lesson' }));

    const page1 = repo.listNodesPage(personaA, { page: 1, pageSize: 2 });
    expect(page1.nodes).toHaveLength(2);
    expect(page1.total).toBe(3);

    const updated = repo.updateMany(personaA, ['p1', 'p2'], { type: 'avoidance', importance: 5 });
    expect(updated).toBe(2);

    const afterUpdate = repo.listNodes(personaA).filter((n) => n.id === 'p1' || n.id === 'p2');
    expect(afterUpdate.every((n) => n.type === 'avoidance')).toBe(true);
    expect(afterUpdate.every((n) => n.importance === 5)).toBe(true);

    const deleted = repo.deleteMany(personaA, ['p1', 'p2']);
    expect(deleted).toBe(2);
    expect(repo.listNodes(personaA)).toHaveLength(1);
    expect(repo.listNodes(personaA)[0].id).toBe('p3');
  });
});
