#!/usr/bin/env node
/**
 * Provision the dedicated PostgreSQL roles used by the World-Model app and
 * worker processes. The command is read-only unless --apply is supplied.
 *
 * Usage:
 *   pnpm run world-model:provision-roles
 *   pnpm run world-model:provision-roles -- --apply
 *
 * Required for --apply:
 *   WORLD_MODEL_ADMIN_DATABASE_URL
 *   WORLD_MODEL_APP_ROLE_PASSWORD
 *   WORLD_MODEL_WORKER_ROLE_PASSWORD
 *
 * The application must receive WORLD_MODEL_APP_DATABASE_URL and the scheduler
 * WORLD_MODEL_WORKER_DATABASE_URL separately. Passwords are never printed.
 */

import { Client } from 'pg';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadEnvConfig } = require('@next/env') as {
  loadEnvConfig: (dir: string, dev?: boolean) => unknown;
};
loadEnvConfig(process.cwd());

const APP_ROLE = 'world_model_app';
const WORKER_ROLE = 'world_model_worker';

const APP_TABLES = [
  'world_model_observations',
  'world_model_entities',
  'world_model_entity_relations',
  'world_model_assertions',
  'world_model_events',
  'world_model_event_transitions',
  'world_model_tasks',
  'world_model_task_transitions',
  'world_model_action_attempts',
  'world_model_open_loops',
  'world_model_standing_intents',
  'world_model_embeddings',
  'world_model_ingestion_checkpoints',
  'world_model_projection_pending',
  'world_model_delivery_receipts',
  'world_model_rebuild_checkpoints',
  'world_model_graphiti_shadow',
];

const WORKER_TABLES = [
  'world_model_outbox_events',
  'world_model_projection_pending',
  'world_model_delivery_receipts',
  'world_model_rebuild_checkpoints',
  'world_model_graphiti_shadow',
];

interface RoleState {
  rolname: string;
  rolcanlogin: boolean;
}

function parseApply(): boolean {
  return process.argv.slice(2).includes('--apply');
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function requireApplySecret(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required with --apply.`);
  return value;
}

async function loadRoleState(client: Client): Promise<RoleState[]> {
  const result = await client.query<RoleState>(
    'SELECT rolname, rolcanlogin FROM pg_roles WHERE rolname = ANY($1::text[]) ORDER BY rolname',
    [[APP_ROLE, WORKER_ROLE]],
  );
  return result.rows;
}

async function existingTables(client: Client): Promise<string[]> {
  const result = await client.query<{ tablename: string }>(
    `SELECT tablename
     FROM pg_tables
     WHERE schemaname = 'public' AND tablename = ANY($1::text[])
     ORDER BY tablename`,
    [[...new Set([...APP_TABLES, ...WORKER_TABLES])]],
  );
  return result.rows.map((row) => row.tablename);
}

async function provisionRole(
  client: Client,
  role: string,
  password: string,
  tables: string[],
): Promise<void> {
  const roles = await loadRoleState(client);
  const exists = roles.some((entry) => entry.rolname === role);
  const roleSql = exists
    ? `ALTER ROLE ${quoteIdentifier(role)} LOGIN PASSWORD ${quoteLiteral(password)}`
    : `CREATE ROLE ${quoteIdentifier(role)} LOGIN PASSWORD ${quoteLiteral(password)}`;
  await client.query(roleSql);
  await client.query(`ALTER ROLE ${quoteIdentifier(role)} SET statement_timeout = '15000ms'`);
  await client.query(
    `ALTER ROLE ${quoteIdentifier(role)} SET idle_in_transaction_session_timeout = '30000ms'`,
  );

  const database = await client.query<{ current_database: string }>('SELECT current_database()');
  await client.query(
    `GRANT CONNECT ON DATABASE ${quoteIdentifier(database.rows[0].current_database)} TO ${quoteIdentifier(role)}`,
  );
  await client.query(`GRANT USAGE ON SCHEMA public TO ${quoteIdentifier(role)}`);

  const available = new Set(await existingTables(client));
  for (const table of tables) {
    if (!available.has(table)) continue;
    // Transactional outbox: both roles need idempotent upsert privileges. The
    // app additionally needs scoped DELETE for the persona privacy lifecycle;
    // worker retirement remains operational-only.
    const privileges =
      table === 'world_model_outbox_events'
        ? role === APP_ROLE
          ? 'SELECT, INSERT, UPDATE, DELETE'
          : 'SELECT, INSERT, UPDATE'
        : 'SELECT, INSERT, UPDATE, DELETE';
    await client.query(
      `GRANT ${privileges} ON TABLE public.${quoteIdentifier(table)} TO ${quoteIdentifier(role)}`,
    );
  }
}

async function main(): Promise<void> {
  const apply = parseApply();
  const adminUrl = process.env.WORLD_MODEL_ADMIN_DATABASE_URL?.trim();
  if (!adminUrl) {
    if (apply) throw new Error('WORLD_MODEL_ADMIN_DATABASE_URL is required with --apply.');
    console.log('DRY RUN: set WORLD_MODEL_ADMIN_DATABASE_URL to inspect the target database.');
    return;
  }

  const client = new Client({ connectionString: adminUrl, connectionTimeoutMillis: 5_000 });
  await client.connect();
  try {
    const database = await client.query<{ current_database: string }>('SELECT current_database()');
    const roles = await loadRoleState(client);
    const tableNames = await existingTables(client);
    console.log(`Database: ${database.rows[0]?.current_database ?? 'unknown'}`);
    console.log(`Existing World-Model tables: ${tableNames.length}`);
    console.log(
      `Roles: ${[APP_ROLE, WORKER_ROLE]
        .map((role) => {
          const state = roles.find((entry) => entry.rolname === role);
          return `${role}=${state ? `present/login=${state.rolcanlogin}` : 'missing'}`;
        })
        .join(', ')}`,
    );

    if (!apply) {
      console.log('DRY RUN: no roles, passwords, grants, or role settings were changed.');
      return;
    }

    const appPassword = requireApplySecret('WORLD_MODEL_APP_ROLE_PASSWORD');
    const workerPassword = requireApplySecret('WORLD_MODEL_WORKER_ROLE_PASSWORD');
    if (appPassword === workerPassword) {
      throw new Error('App and worker role passwords must be different.');
    }

    await client.query('BEGIN');
    try {
      await provisionRole(client, APP_ROLE, appPassword, [
        ...APP_TABLES,
        'world_model_outbox_events',
      ]);
      await provisionRole(client, WORKER_ROLE, workerPassword, WORKER_TABLES);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
    console.log(
      'APPLIED: dedicated World-Model roles are login-enabled and granted only existing World-Model tables.',
    );
    console.log(
      'Next: set WORLD_MODEL_APP_DATABASE_URL and WORLD_MODEL_WORKER_DATABASE_URL, then run a scoped canary.',
    );
  } finally {
    await client.end();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
