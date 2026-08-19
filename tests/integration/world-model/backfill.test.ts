import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  closeWorldModelDb,
  getWorldModelDb,
  runWorldModelMigrations,
  withWorldModelTransaction,
} from '@/server/world-model/db';
import { recordObservation } from '@/server/world-model/services/observationService';

const enabled = process.env.WORLD_MODEL_E2E === 'true';
const marker = 'core-isolated-backfill-user';
const scope = { userId: marker, personaId: 'assistant', workspaceId: 'workspace-a' };

describe.skipIf(!enabled)('world-model backfill logic', () => {
  beforeAll(async () => {
    await runWorldModelMigrations();
  });

  afterAll(async () => {
    await withWorldModelTransaction(async (client) => {
      await client.query('DELETE FROM world_model_outbox_events WHERE user_id = $1', [marker]);
      await client.query('DELETE FROM world_model_observations WHERE user_id = $1', [marker]);
    });
    await closeWorldModelDb();
  });

  it('creates proper artifacts from a simulated message observation backfill', async () => {
    const result = await recordObservation({
      ...scope,
      sourceType: 'chat_message',
      sourceId: `${marker}:msg-1`,
      occurredAt: '2026-08-19T10:00:00.000Z',
      payload: { text: 'Backfill test observation' },
    });
    expect(result.observation.id).toBeDefined();
    expect(result.created).toBe(true);

    const db = getWorldModelDb();
    const rows = await db.query(
      `SELECT id, source_id FROM world_model_observations WHERE user_id = $1 AND source_id = $2`,
      [marker, `${marker}:msg-1`],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].id).toBe(result.observation.id);
  });

  it('is idempotent: replaying the same source produces no duplicate', async () => {
    const result2 = await recordObservation({
      ...scope,
      sourceType: 'chat_message',
      sourceId: `${marker}:msg-1`,
      occurredAt: '2026-08-19T10:00:00.000Z',
      payload: { text: 'Backfill test observation' },
    });
    expect(result2.observation.id).toBeDefined();
    expect(result2.created).toBe(false);

    const db = getWorldModelDb();
    const rows = await db.query(
      `SELECT id FROM world_model_observations WHERE user_id = $1 AND source_id = $2`,
      [marker, `${marker}:msg-1`],
    );
    expect(rows.rows).toHaveLength(1);
  });
});
