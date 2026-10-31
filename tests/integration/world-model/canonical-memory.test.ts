import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const embeddingMocks = vi.hoisted(() => ({
  getConfiguredEmbeddingProvider: vi.fn<MockProcedure>(),
  generateEmbeddingOnce: vi.fn<MockProcedure>(),
}));

vi.mock('@/server/world-model/embeddings/provider', () => ({
  getConfiguredEmbeddingProvider: embeddingMocks.getConfiguredEmbeddingProvider,
  generateEmbeddingOnce: embeddingMocks.generateEmbeddingOnce,
}));

import { PostgresMemoryClient } from '@/server/memory/postgresMemoryClient';
import * as vector from '@/server/world-model/retrieval/vector';
import {
  closeWorldModelDb,
  runWorldModelMigrations,
  withWorldModelTransaction,
} from '@/server/world-model/db';
import type { MockProcedure } from '../../helpers/mockProcedure';

const enabled = process.env.WORLD_MODEL_E2E === 'true';
const marker = `canonical-memory-${Date.now()}`;
const scope = {
  userId: marker,
  personaId: 'assistant',
  workspaceId: 'workspace-a',
};

describe.skipIf(!enabled)('canonical PostgreSQL memory', () => {
  const client = new PostgresMemoryClient();

  beforeEach(() => {
    embeddingMocks.getConfiguredEmbeddingProvider.mockReturnValue(null);
    embeddingMocks.generateEmbeddingOnce.mockReset();
  });

  afterEach(() => vi.restoreAllMocks());

  beforeAll(async () => {
    await runWorldModelMigrations();
  });

  afterAll(async () => {
    await withWorldModelTransaction(async (db) => {
      await db.query('DELETE FROM world_model_embeddings WHERE user_id = $1', [marker]);
      await db.query('DELETE FROM world_model_memory_item_history WHERE user_id = $1', [marker]);
      await db.query('DELETE FROM world_model_memory_items WHERE user_id = $1', [marker]);
    });
    await closeWorldModelDb();
  });

  it('provides scoped CRUD, idempotency, history and soft-delete semantics', async () => {
    const client = new PostgresMemoryClient();
    const input = {
      ...scope,
      content: 'Canonical PostgreSQL memory integration marker',
      metadata: {
        type: 'preference',
        importance: 4,
        idempotencyKey: `${marker}:memory-1`,
      },
    };

    const created = await client.addMemory(input);
    const repeated = await client.addMemory(input);
    expect(created.created).toBe(true);
    expect(repeated).toEqual({ id: created.id, created: false });

    const listed = await client.listMemories({ ...scope, page: 1, pageSize: 10 });
    expect(listed.total).toBe(1);
    expect(listed.memories[0]?.id).toBe(created.id);

    await client.updateMemory(
      created.id,
      {
        ...input,
        content: 'Canonical PostgreSQL memory updated marker',
        metadata: { ...input.metadata, version: 2 },
      },
      scope,
    );
    expect(await client.getMemoryHistory(created.id, scope)).toHaveLength(2);

    await expect(
      client.getMemory(created.id, { ...scope, workspaceId: 'workspace-b' }),
    ).resolves.toBeNull();

    await client.deleteMemory(created.id, scope);
    expect((await client.listMemories({ ...scope, page: 1, pageSize: 10 })).total).toBe(0);
    expect(await client.getMemoryHistory(created.id, scope)).toHaveLength(3);
    const deletedRow = await withWorldModelTransaction(
      (db) =>
        db.query<{ lifecycle_status: string }>(
          'SELECT lifecycle_status FROM world_model_memory_items WHERE id = $1',
          [created.id],
        ),
      scope,
    );
    expect(deletedRow.rows[0]?.lifecycle_status).toBe('deleted');
  });

  it('deduplicates concurrent inserts with the same idempotency key', async () => {
    const input = {
      ...scope,
      content: `${marker} concurrent idempotent insert`,
      metadata: { idempotencyKey: `${marker}:concurrent` },
    };
    const results = await Promise.all(Array.from({ length: 4 }, () => client.addMemory(input)));

    expect(new Set(results.map((result) => result.id)).size).toBe(1);
    expect(results.filter((result) => result.created)).toHaveLength(1);
  });

  it('excludes inactive lifecycle states from canonical recall', async () => {
    const active = await client.addMemory({
      ...scope,
      content: 'Lifecycle recall marker active',
      metadata: {
        type: 'fact',
        lifecycleStatus: 'confirmed',
        idempotencyKey: `${marker}:active`,
      },
    });
    const stale = await client.addMemory({
      ...scope,
      content: 'Lifecycle recall marker stale',
      metadata: {
        type: 'fact',
        lifecycleStatus: 'stale',
        idempotencyKey: `${marker}:stale`,
      },
    });

    const recalled = await client.searchMemories({
      ...scope,
      query: 'Lifecycle recall marker',
      limit: 10,
    });

    expect(recalled.map((entry) => entry.id)).toContain(active.id);
    expect(recalled.map((entry) => entry.id)).not.toContain(stale.id);

    await withWorldModelTransaction(
      (db) =>
        db.query(
          `INSERT INTO world_model_embeddings
            (target_type, target_id, user_id, persona_id, workspace_id, model,
             model_version, embedding, target_content)
           VALUES
            ('memory', $1, $3, $4, $5, 'test', '1', '[1,0]'::vector, 'active'),
            ('memory', $2, $3, $4, $5, 'test', '1', '[1,0]'::vector, 'stale')`,
          [active.id, stale.id, scope.userId, scope.personaId, scope.workspaceId],
        ),
      scope,
    );
    const vectorHits = await vector.vectorSearch(
      [1, 0],
      scope.userId,
      scope.personaId,
      scope.workspaceId,
      10,
      0,
      { include: ['memory'], activeMemoryOnly: true },
    );
    expect(vectorHits.map((entry) => entry.targetId)).toContain(active.id);
    expect(vectorHits.map((entry) => entry.targetId)).not.toContain(stale.id);
  });

  it('normalizes canonical fields and deduplicates legacy provider identities', async () => {
    const created = await client.addMemory({
      userId: marker,
      personaId: scope.personaId,
      content: `${marker} normalized defaults`,
      metadata: {
        workspaceId: scope.workspaceId,
        type: ' preference ',
        importance: 8.7,
        confidence: -2,
        version: 0,
        legacyProvider: ' mem0 ',
        legacyMem0Id: ' legacy-memory-1 ',
      },
    });
    const duplicate = await client.addMemory({
      ...scope,
      content: `${marker} duplicate legacy row`,
      metadata: { legacyProvider: 'mem0', legacyProviderId: 'legacy-memory-1' },
    });

    expect(duplicate).toEqual({ id: created.id, created: false });
    await expect(client.getMemory(created.id, scope)).resolves.toMatchObject({
      metadata: {
        type: 'preference',
        importance: 5,
        confidence: 0.1,
        version: 1,
        workspaceId: scope.workspaceId,
        legacyProviderId: 'legacy-memory-1',
        memoryProvider: 'postgres',
        source: 'postgres',
      },
    });
  });

  it('uses semantic hits when available and falls back to lexical results otherwise', async () => {
    const activeContent = `${marker} semantic query target`;
    const active = await client.addMemory({
      ...scope,
      content: activeContent,
      metadata: { lifecycleStatus: 'confirmed' },
    });
    const provider = {
      model: 'test-embedding',
      modelVersion: '1',
      generateEmbedding: vi.fn<MockProcedure>(),
    };
    embeddingMocks.getConfiguredEmbeddingProvider.mockReturnValue(provider);
    embeddingMocks.generateEmbeddingOnce.mockResolvedValue([1, 0]);
    const search = vi.spyOn(vector, 'vectorSearch').mockResolvedValue([
      {
        targetType: 'memory',
        targetId: active.id,
        text: activeContent,
        similarity: 0.91,
        model: provider.model,
        modelVersion: provider.modelVersion,
      },
      {
        targetType: 'entity',
        targetId: 'unrelated-entity',
        text: 'not a memory',
        similarity: 0.99,
        model: provider.model,
        modelVersion: provider.modelVersion,
      },
      {
        targetType: 'memory',
        targetId: 'missing-memory',
        text: 'stale vector row',
        similarity: 0.8,
        model: provider.model,
        modelVersion: provider.modelVersion,
      },
    ]);

    await expect(
      client.searchMemories({ ...scope, query: ' semantic query ', limit: 5 }),
    ).resolves.toMatchObject([{ id: active.id, score: 0.91 }]);
    expect(search).toHaveBeenCalledWith(
      [1, 0],
      scope.userId,
      scope.personaId,
      scope.workspaceId,
      25,
      0.2,
      { include: ['memory'], activeMemoryOnly: true },
    );

    search.mockResolvedValue([]);
    await expect(
      client.searchMemories({ ...scope, query: 'semantic query', limit: 5 }),
    ).resolves.toMatchObject([{ id: active.id, score: 0.5 }]);

    await expect(client.searchMemories({ ...scope, query: '   ', limit: 5 })).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: active.id, score: null })]),
    );
  });

  it('falls back to lexical recall after semantic search throws', async () => {
    const row = await client.addMemory({
      ...scope,
      content: `${marker} semantic failure fallback`,
      metadata: {},
    });
    embeddingMocks.getConfiguredEmbeddingProvider.mockReturnValue({
      model: 'test-embedding',
      modelVersion: '1',
      generateEmbedding: vi.fn<MockProcedure>(),
    });
    embeddingMocks.generateEmbeddingOnce.mockResolvedValue([1, 0]);
    vi.spyOn(vector, 'vectorSearch').mockRejectedValue(new Error('vector store unavailable'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(
      client.searchMemories({ ...scope, query: 'semantic failure', limit: 5 }),
    ).resolves.toMatchObject([expect.objectContaining({ id: row.id, score: 0.5 })]);
    expect(console.warn).toHaveBeenCalledOnce();
  });

  it('applies trimmed list filters and clamps page inputs', async () => {
    const preference = await client.addMemory({
      ...scope,
      content: `${marker} filter-target preference`,
      metadata: { type: 'preference' },
    });
    await client.addMemory({
      ...scope,
      content: `${marker} filter-target fact`,
      metadata: { type: 'fact' },
    });

    const filtered = await client.listMemories({
      ...scope,
      page: 0,
      pageSize: 500,
      query: ' filter-target ',
      type: ' preference ',
    });
    expect(filtered).toMatchObject({
      total: 1,
      page: 1,
      pageSize: 200,
      memories: [expect.objectContaining({ id: preference.id })],
    });

    await expect(
      client.listMemories({ ...scope, page: Number.POSITIVE_INFINITY, pageSize: Number.NaN }),
    ).resolves.toMatchObject({ page: 1, pageSize: 50 });
  });

  it('supports an omitted persona filter and empty-workspace records', async () => {
    const row = await client.addMemory({
      userId: marker,
      personaId: '',
      workspaceId: 'empty-persona-workspace',
      content: `${marker} empty persona`,
      metadata: {},
    });

    await expect(
      client.listMemories({
        userId: marker,
        workspaceId: 'empty-persona-workspace',
        page: 1,
        pageSize: 50,
      }),
    ).resolves.toMatchObject({
      total: 1,
      memories: [expect.objectContaining({ id: row.id })],
    });

    const unscoped = await client.addMemory({
      userId: marker,
      personaId: scope.personaId,
      content: `${marker} empty workspace`,
      metadata: {},
    });
    await withWorldModelTransaction(
      (db) =>
        db.query("UPDATE world_model_memory_items SET metadata = '[]'::jsonb WHERE id = $1", [
          unscoped.id,
        ]),
      { ...scope, workspaceId: '' },
    );

    await expect(client.getMemory(unscoped.id)).resolves.toMatchObject({
      id: unscoped.id,
      metadata: { memoryProvider: 'postgres' },
    });
    await expect(client.getMemory(unscoped.id)).resolves.not.toHaveProperty('metadata.workspaceId');
  });

  it('supports scoped and unscoped reads and reports missing memories', async () => {
    const row = await client.addMemory({
      ...scope,
      content: `${marker} optional scope`,
      metadata: {},
    });

    await expect(client.getMemory(row.id)).resolves.toMatchObject({ id: row.id });
    await expect(
      client.getMemory(row.id, { ...scope, workspaceId: 'other-workspace' }),
    ).resolves.toBeNull();
    await expect(client.getMemory('00000000-0000-4000-8000-000000000000')).resolves.toBeNull();
    await expect(client.getMemoryHistory(row.id)).resolves.toMatchObject([
      expect.objectContaining({ action: 'create', content: `${marker} optional scope` }),
    ]);
    await expect(
      client.getMemoryHistory('00000000-0000-4000-8000-000000000000', scope),
    ).resolves.toEqual([]);
  });

  it('enforces expected versions, persists update history, and rejects missing rows', async () => {
    const row = await client.addMemory({
      ...scope,
      content: `${marker} before update`,
      metadata: { importance: 2, confidence: 0.6 },
    });
    await client.updateMemory(
      row.id,
      {
        ...scope,
        content: `${marker} after update`,
        metadata: {
          type: 'lesson',
          importance: 7,
          confidence: 1.2,
          expectedVersion: 1,
          transient: 'kept',
        },
      },
      scope,
    );

    await expect(client.getMemory(row.id, scope)).resolves.toMatchObject({
      content: `${marker} after update`,
      metadata: { type: 'lesson', importance: 5, confidence: 1, version: 2 },
    });
    const history = await client.getMemoryHistory(row.id, scope);
    expect(history).toHaveLength(2);
    expect(history[1]).toMatchObject({
      action: 'update',
      metadata: { version: 2, transient: 'kept' },
    });
    expect(history[1]?.metadata).not.toHaveProperty('expectedVersion');

    await expect(
      client.updateMemory(
        row.id,
        { ...scope, content: 'stale update', metadata: { expectedVersion: 1 } },
        scope,
      ),
    ).rejects.toMatchObject({ name: 'MemoryVersionConflictError', currentVersion: 2 });
    await expect(
      client.updateMemory('00000000-0000-4000-8000-000000000000', {
        ...scope,
        content: 'missing update',
        metadata: {},
      }),
    ).rejects.toThrow('Memory node not found');
  });

  it('preserves existing canonical fields when update metadata omits them', async () => {
    const row = await client.addMemory({
      ...scope,
      content: `${marker} update defaults before`,
      metadata: {
        type: 'preference',
        importance: 4,
        confidence: 0.7,
        lifecycleStatus: 'confirmed',
      },
    });

    await client.updateMemory(
      row.id,
      { ...scope, content: `${marker} update defaults after`, metadata: {} },
      scope,
    );

    await expect(client.getMemory(row.id, scope)).resolves.toMatchObject({
      content: `${marker} update defaults after`,
      metadata: {
        type: 'preference',
        importance: 4,
        confidence: 0.7,
        lifecycleStatus: 'confirmed',
      },
    });
  });

  it('requires scoped deletes and removes a memory embedding when soft-deleting', async () => {
    const row = await client.addMemory({
      ...scope,
      content: `${marker} delete target`,
      metadata: {},
    });
    await expect(client.deleteMemory(row.id)).rejects.toThrow('Scoped canonical memory deletion');
    await expect(
      client.deleteMemory('00000000-0000-4000-8000-000000000000', scope),
    ).rejects.toThrow('Memory node not found');
    await withWorldModelTransaction(
      (db) =>
        db.query(
          `INSERT INTO world_model_embeddings
            (target_type, target_id, user_id, persona_id, workspace_id, model,
             model_version, embedding, target_content)
           VALUES ('memory', $1, $2, $3, $4, 'test', '1', '[1,0]'::vector, 'delete target')`,
          [row.id, scope.userId, scope.personaId, scope.workspaceId],
        ),
      scope,
    );

    await client.deleteMemory(row.id, scope);
    const embeddingCount = await withWorldModelTransaction(
      (db) =>
        db.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM world_model_embeddings
           WHERE target_type = 'memory' AND target_id = $1`,
          [row.id],
        ),
      scope,
    );
    expect(embeddingCount.rows[0]?.count).toBe('0');
  });

  it('bulk deletes scoped memories, records history, removes embeddings, and counts active rows', async () => {
    const rows = await Promise.all(
      ['first', 'second'].map((name) =>
        client.addMemory({ ...scope, content: `${marker} bulk ${name}`, metadata: {} }),
      ),
    );
    await withWorldModelTransaction(
      (db) =>
        db.query(
          `INSERT INTO world_model_embeddings
            (target_type, target_id, user_id, persona_id, workspace_id, model,
             model_version, embedding, target_content)
           SELECT 'memory', id::text, user_id, persona_id, workspace_id, 'test', '1', '[1,0]'::vector, content
           FROM world_model_memory_items WHERE id = ANY($1::uuid[])`,
          [rows.map((row) => row.id)],
        ),
      scope,
    );

    expect(await client.countMemories({})).toBe(0);
    expect(await client.countMemories({ userId: marker })).toBeGreaterThanOrEqual(2);
    expect(await client.countMemories(scope)).toBeGreaterThanOrEqual(2);
    expect(await client.deleteMemoriesByFilter(scope)).toBeGreaterThanOrEqual(2);
    await expect(client.countMemories(scope)).resolves.toBe(0);

    const histories = await Promise.all(rows.map((row) => client.getMemoryHistory(row.id, scope)));
    expect(histories.every((entries) => entries.some((entry) => entry.action === 'delete'))).toBe(
      true,
    );
    const remainingEmbeddings = await withWorldModelTransaction(
      (db) =>
        db.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM world_model_embeddings
           WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3 AND target_type = 'memory'`,
          [scope.userId, scope.personaId, scope.workspaceId],
        ),
      scope,
    );
    expect(remainingEmbeddings.rows[0]?.count).toBe('0');
    await expect(client.deleteMemoriesByFilter(scope)).resolves.toBe(0);
  });
});
