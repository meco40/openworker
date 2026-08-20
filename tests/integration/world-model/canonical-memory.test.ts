import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresMemoryClient } from '@/server/memory/postgresMemoryClient';
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
  });
});
