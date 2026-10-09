import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { MemoryNode } from '@/core/memory/types';
import { LEGACY_LOCAL_USER_ID } from '@/server/auth/constants';
import { openSqliteDatabase } from '@/server/db/sqlite';
import { SqliteMemoryRepository } from '@/server/memory/sqliteMemoryRepository';
import { getTestArtifactsRoot } from '../../helpers/testArtifacts';

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
      getTestArtifactsRoot(),
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

  it('isolates memory by user for the same persona id', () => {
    const repo = new SqliteMemoryRepository(dbPath);
    repo.insertNode(personaA, createNode({ id: 'mem-user-a' }), 'user-a');
    repo.insertNode(personaA, createNode({ id: 'mem-user-b' }), 'user-b');

    expect(repo.listNodes(personaA, 'user-a')).toHaveLength(1);
    expect(repo.listNodes(personaA, 'user-b')).toHaveLength(1);
    expect(repo.listNodes(personaA, 'user-a')[0].id).toBe('mem-user-a');
    expect(repo.listNodes(personaA, 'user-b')[0].id).toBe('mem-user-b');
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

  it('resolveUserId: empty string resolves to LEGACY_LOCAL_USER_ID', () => {
    const repo = new SqliteMemoryRepository(dbPath);
    // Insert with empty userId — should map to LEGACY_LOCAL_USER_ID
    repo.insertNode(personaA, createNode({ id: 'mem-legacy' }), '');
    // Retrieve with empty userId — should find it
    const nodes = repo.listNodes(personaA, '');
    expect(nodes).toHaveLength(1);
    expect(nodes[0].id).toBe('mem-legacy');
  });

  it('resolveUserId: whitespace-only string resolves to LEGACY_LOCAL_USER_ID', () => {
    const repo = new SqliteMemoryRepository(dbPath);
    repo.insertNode(personaA, createNode({ id: 'mem-ws-legacy' }), '   ');
    const nodes = repo.listNodes(personaA, '   ');
    expect(nodes).toHaveLength(1);
    expect(nodes[0].id).toBe('mem-ws-legacy');
  });

  it('toNode: empty embedding_json returns empty array', () => {
    const repo = new SqliteMemoryRepository(dbPath);
    repo.insertNode(personaA, createNode({ id: 'mem-empty-embed', embedding: [] }));
    const nodes = repo.listNodes(personaA);
    const node = nodes.find((n) => n.id === 'mem-empty-embed');
    expect(node).toBeDefined();
    expect(node?.embedding).toEqual([]);
  });

  it('toNode: null metadata_json returns undefined metadata', () => {
    const repo = new SqliteMemoryRepository(dbPath);
    // Insert with no metadata (metadata will be null in DB)
    repo.insertNode(personaA, createNode({ id: 'mem-no-meta', metadata: undefined }));
    const nodes = repo.listNodes(personaA);
    const node = nodes.find((n) => n.id === 'mem-no-meta');
    expect(node).toBeDefined();
    expect(node?.metadata).toBeUndefined();
  });

  it('migrate: hasColumn returns true when column already exists (second instance is no-op)', () => {
    // Create first instance — creates the table with all columns
    const repo1 = new SqliteMemoryRepository(dbPath);
    repo1.insertNode(personaA, createNode({ id: 'mem-migrate-check' }));

    // Create second instance on same DB — migrate() should detect columns already exist
    // and not throw (ALTER TABLE would fail if it tries to add existing column)
    expect(() => {
      const repo2 = new SqliteMemoryRepository(dbPath);
      const nodes = repo2.listNodes(personaA);
      expect(nodes[0].id).toBe('mem-migrate-check');
    }).not.toThrow();
  });

  it('migrates legacy tables that do not yet have persona and user scope columns', () => {
    const legacy = openSqliteDatabase({ dbPath });
    legacy.exec(`
      CREATE TABLE memory_nodes (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        embedding_json TEXT NOT NULL DEFAULT '[]',
        importance INTEGER NOT NULL,
        confidence REAL NOT NULL,
        timestamp TEXT NOT NULL,
        metadata_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO memory_nodes (
        id, type, content, embedding_json, importance, confidence, timestamp, metadata_json,
        created_at, updated_at
      ) VALUES ('legacy-memory', 'fact', 'legacy content', '[]', 3, 0.5, '2026-01-01', NULL,
        '2026-01-01', '2026-01-01');
    `);
    legacy.close();

    const repo = new SqliteMemoryRepository(dbPath);
    const records = repo.listAllNodesWithScope();

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      userId: LEGACY_LOCAL_USER_ID,
      personaId: 'persona-default',
      node: { id: 'legacy-memory', content: 'legacy content' },
    });
  });

  it('uses MESSAGES_DB_PATH when MEMORY_DB_PATH is empty', () => {
    const originalMemoryPath = process.env.MEMORY_DB_PATH;
    const originalMessagesPath = process.env.MESSAGES_DB_PATH;
    process.env.MEMORY_DB_PATH = '';
    process.env.MESSAGES_DB_PATH = dbPath;

    try {
      const repo = new SqliteMemoryRepository();
      repo.insertNode(personaA, createNode({ id: 'env-path-node' }));

      expect(repo.listNodes(personaA)[0]?.id).toBe('env-path-node');
    } finally {
      if (originalMemoryPath === undefined) delete process.env.MEMORY_DB_PATH;
      else process.env.MEMORY_DB_PATH = originalMemoryPath;
      if (originalMessagesPath === undefined) delete process.env.MESSAGES_DB_PATH;
      else process.env.MESSAGES_DB_PATH = originalMessagesPath;
    }
  });

  it('returns zero for empty and unmatched bulk mutations', () => {
    const repo = new SqliteMemoryRepository(dbPath);

    expect(repo.updateMany(personaA, [], { type: 'fact' })).toBe(0);
    expect(repo.updateMany(personaA, ['mem-missing'], {})).toBe(0);
    expect(repo.updateMany(personaA, ['mem-missing'], { type: 'lesson' })).toBe(0);
    expect(repo.deleteMany(personaA, ['  ', ''])).toBe(0);
    expect(repo.deleteMany(personaA, ['mem-missing'])).toBe(0);
    expect(repo.updateNode(personaA, createNode({ id: 'mem-missing' }))).toBeUndefined();
    expect(repo.listNodeHistory('mem-missing')).toEqual([]);
    expect(repo.deleteNode(personaA, 'mem-missing')).toBe(0);
    expect(repo.deleteByPersona(personaA)).toBe(0);
  });

  it('normalizes empty legacy JSON fields and returns zero-size storage snapshots', () => {
    const repo = new SqliteMemoryRepository(dbPath);
    repo.insertNode(
      personaA,
      createNode({ id: 'empty-legacy', content: '', embedding: [], metadata: undefined }),
    );
    const rawDb = openSqliteDatabase({ dbPath });
    rawDb
      .prepare('UPDATE memory_nodes SET embedding_json = ? WHERE id = ?')
      .run('', 'empty-legacy');
    rawDb
      .prepare('UPDATE memory_node_history SET metadata_json = ? WHERE node_id = ?')
      .run('', 'empty-legacy');
    rawDb.close();

    expect(repo.listNodes(personaA)[0]?.embedding).toEqual([]);
    expect(repo.listNodeHistory('empty-legacy')[0]?.metadata).toEqual({});
    expect(repo.getStorageSnapshot(Number.NaN, personaA)).toEqual({
      summary: {
        totalNodes: 1,
        totalBytes: 0,
        contentBytes: 0,
        embeddingBytes: 0,
        metadataBytes: 0,
      },
      byType: [
        {
          type: 'fact',
          count: 1,
          contentBytes: 0,
          embeddingBytes: 0,
          metadataBytes: 0,
          totalBytes: 0,
        },
      ],
      largestNodes: [
        {
          id: 'empty-legacy',
          type: 'fact',
          contentBytes: 0,
          embeddingBytes: 0,
          metadataBytes: 0,
          totalBytes: 0,
        },
      ],
    });
    expect(repo.getStorageSnapshot(0).summary.totalNodes).toBe(1);
  });

  it('applies page filters and clamps invalid pagination values', () => {
    const repo = new SqliteMemoryRepository(dbPath);
    repo.insertNode(personaA, createNode({ id: 'page-fact', type: 'fact', content: 'alpha' }));
    repo.insertNode(
      personaA,
      createNode({ id: 'page-preference', type: 'preference', content: 'beta' }),
    );

    const filtered = repo.listNodesPage(personaA, {
      page: 0,
      pageSize: 500,
      type: 'fact',
      query: '  alpha  ',
    });
    const unfiltered = repo.listNodesPage(personaA, { page: 1, pageSize: 10, query: '   ' });

    expect(filtered).toMatchObject({ total: 1, nodes: [{ id: 'page-fact' }] });
    expect(unfiltered.total).toBe(2);
    expect(repo.listNodesPage(personaA, { page: 1, pageSize: 10, query: 'missing' })).toMatchObject(
      {
        total: 0,
        nodes: [],
      },
    );
  });

  it('looks up nodes by ID and scopes all-node reads when a user is supplied', () => {
    const repo = new SqliteMemoryRepository(dbPath);
    repo.insertNode(personaA, createNode({ id: 'user-a-node' }), 'user-a');
    repo.insertNode(personaB, createNode({ id: 'user-b-node' }), 'user-b');

    expect(repo.getNodeById('user-a-node')).toMatchObject({
      userId: 'user-a',
      personaId: personaA,
      node: { id: 'user-a-node' },
    });
    expect(repo.getNodeById('missing')).toBeNull();
    expect(repo.listAllNodesWithScope('user-a').map(({ node }) => node.id)).toEqual([
      'user-a-node',
    ]);
  });

  it('uses empty embeddings for legacy nodes that omit embedding data', () => {
    const repo = new SqliteMemoryRepository(dbPath);
    const node = {
      ...createNode({ id: 'embedding-omitted' }),
      embedding: undefined,
    } as unknown as MemoryNode;

    repo.insertNode(personaA, node);
    repo.updateNode(personaA, node);

    expect(repo.listNodes(personaA)[0]?.embedding).toEqual([]);
  });

  it('returns zero summaries for an empty database', () => {
    const repo = new SqliteMemoryRepository(dbPath);

    expect(repo.getStorageSnapshot()).toEqual({
      summary: {
        totalNodes: 0,
        totalBytes: 0,
        contentBytes: 0,
        embeddingBytes: 0,
        metadataBytes: 0,
      },
      byType: [],
      largestNodes: [],
    });
  });
});
