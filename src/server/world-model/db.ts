import fs from 'node:fs';
import path from 'node:path';

import { Pool, type QueryResult, type QueryResultRow } from 'pg';

import { getWorldModelConfig } from '@/server/world-model/config';

const POOL_LOG_TAG = '[world-model:db]';

declare global {
  // eslint-disable-next-line no-var
  var __worldModelPool: Pool | undefined;
}

export interface WorldModelDb {
  pool: Pool;
  query: WorldModelQueryExecutor['query'];
}

export interface WorldModelQueryExecutor {
  query: <T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ) => Promise<QueryResult<T>>;
}

function buildPool(): Pool {
  const config = getWorldModelConfig();
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: config.poolMax,
    idleTimeoutMillis: config.poolIdleTimeoutMs,
  });
  pool.on('error', (error) => {
    console.error(POOL_LOG_TAG, 'unexpected pool error:', error);
  });
  return pool;
}

export function getWorldModelDb(): WorldModelDb {
  if (!globalThis.__worldModelPool) {
    globalThis.__worldModelPool = buildPool();
  }
  const pool = globalThis.__worldModelPool;
  return {
    pool,
    query: (text, values) => pool.query(text, values),
  };
}

export async function closeWorldModelDb(): Promise<void> {
  if (globalThis.__worldModelPool) {
    await globalThis.__worldModelPool.end();
    globalThis.__worldModelPool = undefined;
  }
}

async function isConnectionUsable(pool: Pool): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

async function applyMigrations(client: WorldModelQueryExecutor): Promise<string[]> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS _world_model_migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  const migrationsDir = path.join(process.cwd(), 'src', 'server', 'world-model', 'migrations');
  const files = fs
    .readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort();

  const applied: string[] = [];
  for (const file of files) {
    const id = file.replace(/\.sql$/, '');
    const { rowCount } = await client.query('SELECT 1 FROM _world_model_migrations WHERE id = $1', [
      id,
    ]);
    if ((rowCount ?? 0) > 0) {
      continue;
    }
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO _world_model_migrations (id) VALUES ($1)', [id]);
      await client.query('COMMIT');
      applied.push(id);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }
  return applied;
}

export async function runWorldModelMigrations(): Promise<string[]> {
  const db = getWorldModelDb();
  const usable = await isConnectionUsable(db.pool);
  if (!usable) {
    throw new Error(
      `${POOL_LOG_TAG} canonical PostgreSQL is not reachable at ${getWorldModelConfig().databaseUrl}`,
    );
  }
  const client = await db.pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [
      'clawtest:world-model:migrations',
    ]);
    return await applyMigrations(client);
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [
        'clawtest:world-model:migrations',
      ]);
    } finally {
      client.release();
    }
  }
}

export async function withWorldModelTransaction<T>(
  callback: (db: WorldModelQueryExecutor) => Promise<T>,
): Promise<T> {
  const client = await getWorldModelDb().pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error(POOL_LOG_TAG, 'transaction rollback failed:', rollbackError);
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function resetWorldModelDbForTests(): Promise<void> {
  await closeWorldModelDb();
}
