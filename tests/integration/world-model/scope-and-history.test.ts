import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { getWorldModelDb, runWorldModelMigrations } from '@/server/world-model/db';
import { scopeWhere } from '@/server/world-model/scope';
import { insertObservationWithResult } from '@/server/world-model/repositories/observationRepository';
import type { ObservationInput } from '@/server/world-model/types';

const enabled = process.env.WORLD_MODEL_E2E === 'true';
const marker = `scope-hist-${Date.now()}`;

function obs(
  scope: { userId: string; personaId: string; workspaceId: string },
  seq: number,
): ObservationInput {
  return {
    userId: scope.userId,
    personaId: scope.personaId,
    workspaceId: scope.workspaceId,
    sourceType: 'chat_message',
    sourceId: `${marker}:${seq}`,
    occurredAt: new Date().toISOString(),
    payload: { text: 'scope-test' },
  };
}

describe.skipIf(!enabled)('world-model scope and history', () => {
  beforeAll(async () => {
    await runWorldModelMigrations();
  });

  afterAll(async () => {
    const db = getWorldModelDb();
    await db.query('DELETE FROM world_model_observations WHERE source_id LIKE $1', [`${marker}%`]);
    await db.pool.end();
  });

  it('scopeWhere produces scoped SQL parameters', () => {
    const { clause, values } = scopeWhere({ userId: 'u', personaId: 'p', workspaceId: 'w' });
    expect(clause).toContain('user_id = $1');
    expect(clause).toContain('persona_id = $2');
    expect(clause).toContain('workspace_id = $3');
    expect(values).toEqual(['u', 'p', 'w']);
  });

  it('isolates observations by workspace scope and is idempotent on replay', async () => {
    const scopeA = { userId: 'u', personaId: 'p', workspaceId: 'ws-a' };
    const { observation, created } = await insertObservationWithResult(obs(scopeA, 1));
    expect(created).toBe(true);
    expect(observation.workspaceId).toBe('ws-a');

    const replayed = await insertObservationWithResult(obs(scopeA, 1));
    expect(replayed.created).toBe(false);

    const db = getWorldModelDb();
    const res = await db.query(
      'SELECT workspace_id FROM world_model_observations WHERE user_id = $1 AND persona_id = $2 AND source_id LIKE $3',
      ['u', 'p', `${marker}%`],
    );
    expect(res.rows.length).toBeGreaterThan(0);
    for (const row of res.rows as Array<{ workspace_id: string }>) {
      expect(row.workspace_id).toBe('ws-a');
    }
  });

  it('allows the same historical sentence to be re-asserted via a new source', async () => {
    const scope = { userId: 'u', personaId: 'p', workspaceId: 'ws-a' };
    const first = await insertObservationWithResult(obs(scope, 2));
    const second = await insertObservationWithResult(obs(scope, 3));
    expect(first.observation.id).not.toBe(second.observation.id);
  });
});
