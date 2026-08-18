import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { getWorldModelDb, runWorldModelMigrations } from '@/server/world-model/db';

const enabled = process.env.WORLD_MODEL_E2E === 'true';
const marker = `rls-contract-${Date.now()}`;

describe.skipIf(!enabled)('world-model RLS scaffolding', () => {
  beforeAll(async () => {
    await runWorldModelMigrations();
  });

  afterAll(async () => {
    await getWorldModelDb().query('DELETE FROM world_model_observations WHERE source_id LIKE $1', [
      `${marker}%`,
    ]);
    await getWorldModelDb().pool.end();
  });

  it('creates the scope set_config function', async () => {
    const db = getWorldModelDb();
    const res = await db.query(
      "SELECT proname FROM pg_proc WHERE proname = 'world_model_set_scope'",
    );
    expect(res.rows.length).toBeGreaterThan(0);
  });

  it('sets the session scope and reads it back', async () => {
    const client = await getWorldModelDb().pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT world_model_set_scope('u','p','w')");
      const res = await client.query(
        "SELECT current_setting('world_model.user_id', true) AS uid, " +
          "current_setting('world_model.persona_id', true) AS pid, " +
          "current_setting('world_model.workspace_id', true) AS wid",
      );
      expect(res.rows[0].uid).toBe('u');
      expect(res.rows[0].pid).toBe('p');
      expect(res.rows[0].wid).toBe('w');
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('prevents a dedicated app role from reading another workspace', async () => {
    const db = getWorldModelDb();
    await db.query(
      `INSERT INTO world_model_observations
        (user_id, persona_id, workspace_id, source_type, source_id, occurred_at, payload)
       VALUES
        ('u','p','workspace-a','chat_message',$1,now(),'{}'::jsonb),
        ('u','p','workspace-b','chat_message',$2,now(),'{}'::jsonb)`,
      [`${marker}-a`, `${marker}-b`],
    );

    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE world_model_app');
      await client.query("SELECT world_model_set_scope('u','p','workspace-a')");
      const result = await client.query(
        'SELECT workspace_id FROM world_model_observations WHERE source_id LIKE $1',
        [`${marker}%`],
      );
      expect(result.rows).toEqual([{ workspace_id: 'workspace-a' }]);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });
});
