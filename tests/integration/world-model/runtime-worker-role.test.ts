import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import {
  getWorldModelDb,
  runWorldModelMigrations,
  closeWorldModelDb,
} from '@/server/world-model/db';
import {
  insertOpenLoop,
  claimDueOpenLoop,
  markOpenLoopAsked,
  insertStandingIntent,
  registerStandingIntentFire,
} from '@/server/world-model/repositories/prospectiveRepository';

const enabled = process.env.WORLD_MODEL_E2E === 'true';
const marker = `runtime-worker-${Date.now()}`;
let client: Client;

describe.skipIf(!enabled)('provisioned worker privileges and scope', () => {
  beforeAll(async () => {
    await runWorldModelMigrations();
    client = new Client({
      connectionString:
        process.env.WORLD_MODEL_ADMIN_DATABASE_URL || process.env.CANONICAL_DATABASE_URL,
    });
    await client.connect();
  });
  afterAll(async () => {
    if (client) await client.end();
    await closeWorldModelDb();
  });

  it('executes proactive transitions and cannot read a different scope or migrate', async () => {
    await client.query('BEGIN');
    try {
      await client.query('SET LOCAL ROLE world_model_worker');
      await client.query('SELECT world_model_set_scope($1,$2,$3)', [
        marker,
        'assistant',
        'workspace',
      ]);
      const query = client.query.bind(client);
      const db = { query };
      const loop = await insertOpenLoop(
        {
          userId: marker,
          personaId: 'assistant',
          workspaceId: 'workspace',
          type: 'clarification',
          question: 'Synthetic release probe?',
          importance: 1,
          deduplicationKey: marker + '-loop',
          maxAttempts: 2,
        },
        db,
      );
      const now = new Date().toISOString();
      const claimed = await claimDueOpenLoop(
        marker,
        'assistant',
        now,
        'workspace',
        'worker-probe',
        60_000,
        db,
      );
      expect(claimed?.id).toBe(loop.id);
      await markOpenLoopAsked(loop.id, now, db);
      const intent = await insertStandingIntent(
        {
          userId: marker,
          personaId: 'assistant',
          workspaceId: 'workspace',
          description: 'Synthetic intent',
          triggerTerms: ['release'],
          cooldownMs: 0,
          maxFires: 1,
          deduplicationKey: marker + '-intent',
        },
        db,
      );
      await registerStandingIntentFire(intent.id, now, db);
      expect(
        (await query('SELECT status FROM world_model_open_loops WHERE id=$1', [loop.id])).rows[0]
          .status,
      ).toBe('asked');
      expect(
        (await query('SELECT status FROM world_model_standing_intents WHERE id=$1', [intent.id]))
          .rows[0].status,
      ).toBe('done');
      await query('SELECT world_model_set_scope($1,$2,$3)', [
        marker + '-other',
        'assistant',
        'workspace',
      ]);
      expect(
        (await query('SELECT id FROM world_model_open_loops WHERE id=$1', [loop.id])).rowCount,
      ).toBe(0);
      expect(
        (
          await query(
            "SELECT has_schema_privilege(current_user, 'public', 'CREATE') AS can_migrate",
          )
        ).rows[0].can_migrate,
      ).toBe(false);
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('keeps the existing administrative test connection usable', async () => {
    expect((await getWorldModelDb().query('SELECT 1 AS ok')).rows[0].ok).toBe(1);
  });
});
