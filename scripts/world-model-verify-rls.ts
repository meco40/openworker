#!/usr/bin/env node
/**
 * World Model Runtime-Role / RLS verification.
 *
 * Phase 15 evidence: proves that the dedicated runtime roles
 * (world_model_app / world_model_worker) are login-enabled, scope-enforced
 * via RLS, and least-privilege granted. Read-only against business data:
 * it writes and removes one clearly marked probe row per run.
 *
 * Usage:
 *   pnpm run world-model:verify-rls
 *
 * Requires WORLD_MODEL_APP_DATABASE_URL and WORLD_MODEL_WORKER_DATABASE_URL
 * (see scripts/world-model-provision-roles.ts).
 */

import { Client } from 'pg';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadEnvConfig } = require('@next/env') as {
  loadEnvConfig: (dir: string, dev?: boolean) => unknown;
};
loadEnvConfig(process.cwd());

const PROBE_SOURCE_ID = `rls-verify-${Date.now()}`;
const SCOPE_A = { user: 'rls-verify-user-a', persona: 'rls-verify-persona', workspace: 'ws-a' };
const SCOPE_B = { user: 'rls-verify-user-b', persona: 'rls-verify-persona', workspace: 'ws-b' };

interface Check {
  name: string;
  passed: boolean;
  detail: string;
}

const checks: Check[] = [];
function record(name: string, passed: boolean, detail: string): void {
  checks.push({ name, passed, detail });
}

function requireUrl(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required. Run world-model:provision-roles first.`);
  return value;
}

async function selectObservationIds(client: Client): Promise<string[]> {
  const result = await client.query<{ id: string }>(
    `SELECT id FROM world_model_observations WHERE source_id = $1`,
    [PROBE_SOURCE_ID],
  );
  return result.rows.map((row) => row.id);
}

async function verifyAppRole(url: string): Promise<void> {
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await client.connect();
  try {
    const who = await client.query<{ current_user: string }>('SELECT current_user');
    record(
      'app role connects as world_model_app',
      who.rows[0]?.current_user === 'world_model_app',
      `current_user=${who.rows[0]?.current_user}`,
    );

    // Unscoped session: RLS hides every scoped row.
    const unscoped = await client.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM world_model_observations',
    );
    record(
      'app role without scope sees zero rows (RLS deny-all)',
      unscoped.rows[0]?.count === '0',
      `visible rows=${unscoped.rows[0]?.count}`,
    );

    // Scoped session A: insert probe row, then read it back.
    await client.query('BEGIN');
    await client.query('SELECT world_model_set_scope($1, $2, $3)', [
      SCOPE_A.user,
      SCOPE_A.persona,
      SCOPE_A.workspace,
    ]);
    await client.query(
      `INSERT INTO world_model_observations (user_id, persona_id, workspace_id, source_type, source_id, occurred_at, payload)
       VALUES ($1, $2, $3, 'automation', $4, now(), $5::jsonb)`,
      [SCOPE_A.user, SCOPE_A.persona, SCOPE_A.workspace, PROBE_SOURCE_ID, '{}'],
    );
    const inScopeA = await selectObservationIds(client);
    await client.query('COMMIT');
    record(
      'app role inserts and reads row inside its scope',
      inScopeA.length === 1,
      `rows in scope A=${inScopeA.length}`,
    );

    // Scoped session B: the probe row of scope A must be invisible.
    await client.query('BEGIN');
    await client.query('SELECT world_model_set_scope($1, $2, $3)', [
      SCOPE_B.user,
      SCOPE_B.persona,
      SCOPE_B.workspace,
    ]);
    const inScopeB = await selectObservationIds(client);
    await client.query('COMMIT');
    record(
      'cross-scope isolation: scope B cannot see scope A row',
      inScopeB.length === 0,
      `rows in scope B=${inScopeB.length}`,
    );

    // Cross-scope write must be rejected by the WITH CHECK clause.
    await client.query('BEGIN');
    await client.query('SELECT world_model_set_scope($1, $2, $3)', [
      SCOPE_B.user,
      SCOPE_B.persona,
      SCOPE_B.workspace,
    ]);
    let crossWriteRejected = false;
    try {
      await client.query(
        `INSERT INTO world_model_observations (user_id, persona_id, workspace_id, source_type, source_id, occurred_at, payload)
         VALUES ($1, $2, $3, 'automation', $4, now(), $5::jsonb)`,
        [SCOPE_A.user, SCOPE_A.persona, SCOPE_A.workspace, `${PROBE_SOURCE_ID}-x`, '{}'],
      );
    } catch {
      crossWriteRejected = true;
    }
    await client.query('ROLLBACK');
    record(
      'cross-scope write rejected by RLS WITH CHECK',
      crossWriteRejected,
      crossWriteRejected ? 'insert raised error' : 'insert unexpectedly succeeded',
    );

    // Cleanup of the probe row from scope A.
    await client.query('BEGIN');
    await client.query('SELECT world_model_set_scope($1, $2, $3)', [
      SCOPE_A.user,
      SCOPE_A.persona,
      SCOPE_A.workspace,
    ]);
    const deleted = await client.query(
      'DELETE FROM world_model_observations WHERE source_id = $1',
      [PROBE_SOURCE_ID],
    );
    await client.query('COMMIT');
    record('probe row cleaned up', (deleted.rowCount ?? 0) === 1, `deleted=${deleted.rowCount}`);

    // Migration bookkeeping table must not be readable by the app role.
    let migrationsDenied = false;
    try {
      await client.query('SELECT count(*) FROM _world_model_migrations');
    } catch {
      migrationsDenied = true;
    }
    record(
      'app role cannot read _world_model_migrations (least privilege)',
      migrationsDenied,
      migrationsDenied ? 'permission denied' : 'unexpectedly readable',
    );
  } finally {
    await client.end();
  }
}

async function verifyWorkerRole(url: string): Promise<void> {
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await client.connect();
  try {
    const who = await client.query<{ current_user: string }>('SELECT current_user');
    record(
      'worker role connects as world_model_worker',
      who.rows[0]?.current_user === 'world_model_worker',
      `current_user=${who.rows[0]?.current_user}`,
    );

    // Worker has no grant on business tables.
    let observationsDenied = false;
    try {
      await client.query('SELECT count(*) FROM world_model_observations');
    } catch {
      observationsDenied = true;
    }
    record(
      'worker role cannot read world_model_observations (no grant)',
      observationsDenied,
      observationsDenied ? 'permission denied' : 'unexpectedly readable',
    );

    // Worker can read the outbox (its job), scoped.
    await client.query('BEGIN');
    await client.query('SELECT world_model_set_scope($1, $2, $3)', ['rls-verify', 'worker', '']);
    let outboxReadable = true;
    let outboxDetail = 'ok';
    try {
      await client.query('SELECT count(*) FROM world_model_outbox_events');
    } catch (error) {
      outboxReadable = false;
      outboxDetail = error instanceof Error ? error.message : String(error);
    }
    await client.query('COMMIT');
    record('worker role reads world_model_outbox_events', outboxReadable, outboxDetail);

    // Worker must not delete from the outbox (SELECT/UPDATE only).
    let deleteDenied = false;
    try {
      await client.query('BEGIN');
      await client.query('SELECT world_model_set_scope($1, $2, $3)', ['rls-verify', 'worker', '']);
      await client.query(`DELETE FROM world_model_outbox_events WHERE false`);
      await client.query('COMMIT');
    } catch {
      deleteDenied = true;
      try {
        await client.query('ROLLBACK');
      } catch {
        /* already aborted */
      }
    }
    record(
      'worker role cannot delete outbox rows (SELECT/UPDATE only)',
      deleteDenied,
      deleteDenied ? 'permission denied' : 'delete unexpectedly allowed',
    );
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  await verifyAppRole(requireUrl('WORLD_MODEL_APP_DATABASE_URL'));
  await verifyWorkerRole(requireUrl('WORLD_MODEL_WORKER_DATABASE_URL'));

  let failed = 0;
  for (const check of checks) {
    console.log(`${check.passed ? 'PASS' : 'FAIL'}  ${check.name}  (${check.detail})`);
    if (!check.passed) failed += 1;
  }
  console.log(`${checks.length - failed}/${checks.length} checks passed`);
  if (failed > 0) process.exitCode = 1;
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
