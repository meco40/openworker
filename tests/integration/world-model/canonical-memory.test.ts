import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@/server/world-model/embeddings/provider', () => ({
  getConfiguredEmbeddingProvider: () => null,
  generateEmbeddingOnce: vi.fn(),
}));

import { PostgresMemoryClient } from '@/server/memory/postgresMemoryClient';
import { vectorSearch } from '@/server/world-model/retrieval/vector';
import {
  closeWorldModelDb,
  runWorldModelMigrations,
  withWorldModelTransaction,
} from '@/server/world-model/db';

const enabled = process.env.WORLD_MODEL_E2E === 'true';
const marker = `canonical-memory-${Date.now()}`;
const scope = {
  userId: marker,
  personaId: 'assistant',
  workspaceId: 'workspace-a',
};

describe.skipIf(!enabled)('canonical PostgreSQL memory', () => {
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

  it('excludes inactive lifecycle states from canonical recall', async () => {
    const client = new PostgresMemoryClient();
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
    const vectorHits = await vectorSearch(
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
});
