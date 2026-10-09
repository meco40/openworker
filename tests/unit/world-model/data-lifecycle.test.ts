import { describe, expect, it, vi } from 'vitest';
import type { WorldModelQueryExecutor } from '@/server/world-model/db';
import {
  buildScopeWhere,
  deleteWorldModelScope,
  exportWorldModelScope,
  hashWorldModelExport,
  purgeWorldModelRetention,
  restoreWorldModelScope,
  type RetentionPolicy,
  type WorldModelExport,
} from '@/server/world-model/dataLifecycle';

const scope = { userId: 'user-1', personaId: 'assistant', workspaceId: 'workspace-a' };

function createExport(tables: Record<string, Record<string, unknown>[]>): WorldModelExport {
  return {
    scope,
    exportedAt: '2026-10-08T00:00:00.000Z',
    schemaVersion: 1,
    manifestHash: hashWorldModelExport({ scope, tables }),
    tables,
  };
}

function createExecutor(
  respond: (
    text: string,
    values?: unknown[],
  ) => {
    rows: Record<string, unknown>[];
    rowCount?: number | null;
  } = () => ({ rows: [], rowCount: 0 }),
) {
  const calls: Array<{ text: string; values?: unknown[] }> = [];
  const query = vi.fn(async (text: string, values?: unknown[]) => {
    calls.push({ text, values });
    return respond(text, values);
  });
  return { db: { query } as unknown as WorldModelQueryExecutor, calls, query };
}

describe('World Model data lifecycle', () => {
  it('hashes JSON exports deterministically across object key order and dates', () => {
    const first = {
      entities: [
        {
          createdAt: new Date('2026-01-02T03:04:05.000Z'),
          nested: { z: 1, a: 2 },
          custom: { toJSON: () => ({ b: 2, a: 1 }) },
          values: [null, 'text', 3],
        },
      ],
    };
    const reordered = {
      entities: [
        {
          values: [null, 'text', 3],
          custom: { toJSON: () => ({ a: 1, b: 2 }) },
          nested: { a: 2, z: 1 },
          createdAt: new Date('2026-01-02T03:04:05.000Z'),
        },
      ],
    };

    expect(hashWorldModelExport({ scope, tables: first })).toBe(
      hashWorldModelExport({ scope, tables: reordered }),
    );
    expect(
      hashWorldModelExport({
        scope,
        tables: { entities: [{ ...first.entities[0], z: 'changed' }] },
      }),
    ).not.toBe(hashWorldModelExport({ scope, tables: first }));
  });

  it('exports all tables with scoped predicates, including parent-scoped transition rows', async () => {
    const { db, calls } = createExecutor();
    const exported = await exportWorldModelScope(scope, db);

    expect(calls).toHaveLength(18);
    expect(calls.every((call) => call.values?.join('|') === 'user-1|assistant|workspace-a')).toBe(
      true,
    );
    expect(
      calls
        .find((call) => call.text.includes('world_model_event_transitions'))
        ?.text.includes(
          'parent.user_id = $1 AND parent.persona_id = $2 AND parent.workspace_id = $3',
        ),
    ).toBe(true);
    expect(
      calls
        .find((call) => call.text.includes('world_model_task_transitions'))
        ?.text.includes('parent.user_id = $1'),
    ).toBe(true);
    expect(exported.manifestHash).toBe(hashWorldModelExport({ scope, tables: exported.tables }));
    await expect(
      exportWorldModelScope({ userId: 'user-1', personaId: 'assistant' }, db),
    ).rejects.toThrow(/require userId, personaId and workspaceId/);
    expect(calls).toHaveLength(18);
  });

  it('rejects restores with an unsupported schema, wrong scope, or modified manifest', async () => {
    const exported = createExport({ world_model_entities: [{ id: 'entity-1' }] });
    const { db, query } = createExecutor();

    await expect(
      restoreWorldModelScope(
        scope,
        { ...exported, schemaVersion: 2 } as unknown as WorldModelExport,
        db,
      ),
    ).rejects.toThrow('Unsupported World Model export schema');
    await expect(
      restoreWorldModelScope({ ...scope, workspaceId: 'workspace-b' }, exported, db),
    ).rejects.toThrow('scope does not match');
    await expect(
      restoreWorldModelScope(scope, { ...exported, manifestHash: 'modified' }, db),
    ).rejects.toThrow('manifest hash does not match');
    await expect(
      restoreWorldModelScope({ userId: 'user-1', personaId: 'assistant' }, exported, db),
    ).rejects.toThrow(/require userId, personaId and workspaceId/);
    expect(query).not.toHaveBeenCalled();
  });

  it('restores non-empty rows in dependency order with escaped identifiers', async () => {
    const exported = createExport({
      world_model_entities: [{ id: 'entity-1', 'quoted"column': 'value' }, {}],
      world_model_entity_relations: [{ id: 'relation-1', entity_id: 'entity-1' }],
    });
    const { db, calls } = createExecutor(() => ({ rows: [], rowCount: 1 }));

    const result = await restoreWorldModelScope(scope, exported, db);

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      text: expect.stringContaining('INSERT INTO world_model_entities ("id", "quoted""column")'),
      values: ['entity-1', 'value'],
    });
    expect(calls[1]?.text).toContain('INSERT INTO world_model_entity_relations');
    expect(result.restored.world_model_entities).toBe(1);
    expect(result.restored.world_model_entity_relations).toBe(1);
    expect(result.restored.world_model_assertions).toBe(0);
    expect(result.manifestHash).toBe(exported.manifestHash);
  });

  it('deletes only the complete scope in dependency order and reports external cleanup', async () => {
    const { db, calls } = createExecutor((text) => ({
      rows: [],
      rowCount: text.includes('delivery_receipts') ? null : 2,
    }));

    const result = await deleteWorldModelScope(scope, db);

    expect(calls).toHaveLength(16);
    expect(calls[0]?.text).toContain('DELETE FROM world_model_delivery_receipts');
    expect(calls[15]?.text).toContain('DELETE FROM world_model_observations');
    expect(calls.every((call) => call.values?.join('|') === 'user-1|assistant|workspace-a')).toBe(
      true,
    );
    expect(result.deleted.world_model_delivery_receipts).toBe(0);
    expect(result.deleted.world_model_observations).toBe(2);
    expect(result.externalProjectionCleanupRequired).toEqual(['mem0', 'graphiti']);
    await expect(
      deleteWorldModelScope({ userId: 'user-1', personaId: 'assistant' }, db),
    ).rejects.toThrow(/require userId, personaId and workspaceId/);
    expect(calls).toHaveLength(16);
  });

  it('purges with per-category retention cutoffs and keeps the scope on every query', async () => {
    const policy: RetentionPolicy = {
      observationsDays: -5,
      assertionsDays: 10,
      eventsDays: 20,
      openLoopsDays: 30,
      outboxDays: 40,
    };
    const { db, calls } = createExecutor((text) => ({
      rows: [],
      rowCount: text.includes('world_model_events') ? 3 : null,
    }));
    const before = Date.now();

    const result = await purgeWorldModelRetention(scope, policy, db);

    expect(calls).toHaveLength(5);
    expect(calls.map((call) => call.text)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("status IN ('completed','cancelled','no_show')"),
        expect.stringContaining("status IN ('answered','resolved','cancelled','expired')"),
        expect.stringContaining("status IN ('dispatched','permanent_failure')"),
      ]),
    );
    expect(
      calls.every((call) => call.values?.slice(0, 3).join('|') === 'user-1|assistant|workspace-a'),
    ).toBe(true);
    expect(Date.parse(result.cutoff.observationsDays)).toBeGreaterThanOrEqual(before - 1_000);
    expect(Date.parse(result.cutoff.observationsDays)).toBeLessThanOrEqual(Date.now());
    expect(result.deleted.world_model_events).toBe(3);
    expect(result.deleted.world_model_outbox_events).toBe(0);
    expect(buildScopeWhere({ workspaceId: 'workspace-a' }, 4, 'row')).toEqual({
      clause: 'row.workspace_id = $4',
      values: ['workspace-a'],
    });
    await expect(
      purgeWorldModelRetention({ userId: 'user-1', personaId: 'assistant' }, policy, db),
    ).rejects.toThrow(/require userId, personaId and workspaceId/);
    expect(calls).toHaveLength(5);
  });
});
