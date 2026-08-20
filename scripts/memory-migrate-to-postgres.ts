#!/usr/bin/env node
/**
 * One-way, idempotent migration from the legacy Mem0 projection into the
 * canonical PostgreSQL World Model memory store.
 *
 * Mem0 does not expose a provider-wide list endpoint. Therefore the command
 * migrates all explicitly supplied or application-discovered scopes and emits
 * that coverage limitation in its report instead of claiming an impossible
 * global inventory.
 *
 * Dry-run is the default. Apply requires --apply and should be followed by a
 * second dry-run plus a provider shutdown/health check.
 */

import fs from 'node:fs';
import { createRequire } from 'node:module';
import { Pool } from 'pg';

const require = createRequire(import.meta.url);
const { loadEnvConfig } = require('@next/env') as {
  loadEnvConfig: (dir: string, dev?: boolean) => unknown;
};
loadEnvConfig(process.cwd());

import { createMem0ClientFromEnv } from '@/server/memory/mem0';
import type { Mem0MemoryRecord } from '@/server/memory/mem0';
import { PostgresMemoryClient } from '@/server/memory/postgresMemoryClient';
import {
  getWorldModelDb,
  runWorldModelMigrations,
  closeWorldModelDb,
} from '@/server/world-model/db';
import type { WorldModelScope } from '@/server/world-model/scope';

type MigrationScope = Required<WorldModelScope>;

interface ScopeReport {
  scope: MigrationScope;
  sourceMemories: number;
  migrated: number;
  alreadyPresent: number;
  errors: string[];
}

interface MigrationReport {
  generatedAt: string;
  mode: 'dry-run' | 'apply';
  sourceProvider: 'mem0';
  destinationProvider: 'postgres';
  providerWideListSupported: false;
  coverage: {
    discoveredScopes: number;
    limitation: string;
  };
  scopes: ScopeReport[];
  totals: {
    sourceMemories: number;
    migrated: number;
    alreadyPresent: number;
    errors: number;
  };
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function parseScope(value: string): MigrationScope {
  const parts = value.split(':');
  const userId = String(parts[0] || '').trim();
  const personaId = String(parts[1] || '').trim();
  const workspaceId = String(parts.slice(2).join(':') || '').trim();
  if (!userId || !personaId) {
    throw new Error(`Invalid scope '${value}'. Expected userId:personaId[:workspaceId].`);
  }
  return { userId, personaId, workspaceId };
}

function addScope(scopes: Map<string, MigrationScope>, scope: MigrationScope): void {
  scopes.set(`${scope.userId}\u0000${scope.personaId}\u0000${scope.workspaceId}`, scope);
}

async function discoverScopes(): Promise<MigrationScope[]> {
  const scopes = new Map<string, MigrationScope>();
  const configured = String(process.env.WORLD_MODEL_MIGRATION_SCOPES || '').trim();
  for (const value of configured
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)) {
    addScope(scopes, parseScope(value));
  }

  try {
    const adminUrl = process.env.WORLD_MODEL_ADMIN_DATABASE_URL?.trim();
    const dedicatedPool = Boolean(adminUrl);
    const pool = adminUrl
      ? new Pool({ connectionString: adminUrl, max: 1, idleTimeoutMillis: 5000 })
      : getWorldModelDb().pool;
    try {
      const result = await pool.query<{
        user_id: string;
        persona_id: string;
        workspace_id: string;
      }>(`
        SELECT DISTINCT user_id, persona_id, workspace_id FROM world_model_observations
        UNION
        SELECT DISTINCT user_id, persona_id, workspace_id FROM world_model_entities
        UNION
        SELECT DISTINCT user_id, persona_id, workspace_id FROM world_model_tasks
        UNION
        SELECT DISTINCT user_id, persona_id, workspace_id
        FROM world_model_memory_items WHERE deleted_at IS NULL
      `);
      for (const row of result.rows) {
        addScope(scopes, {
          userId: row.user_id,
          personaId: row.persona_id,
          workspaceId: row.workspace_id || '',
        });
      }
    } finally {
      if (dedicatedPool) await pool.end();
    }
  } catch {
    // The explicit-scope path remains useful when the destination is being
    // provisioned for the first time.
  }

  return [...scopes.values()];
}

async function listAllMemories(
  client: NonNullable<ReturnType<typeof createMem0ClientFromEnv>>,
  scope: MigrationScope,
): Promise<Mem0MemoryRecord[]> {
  const memories: Mem0MemoryRecord[] = [];
  let page = 1;
  while (page <= 10_000) {
    const result = await client.listMemories({
      userId: scope.userId,
      personaId: scope.personaId,
      page,
      pageSize: 200,
    });
    memories.push(...result.memories);
    if (result.memories.length === 0 || memories.length >= result.total) break;
    page += 1;
  }
  if (page > 10_000) throw new Error('Mem0 pagination exceeded the migration safety limit.');
  return memories;
}

async function migrateScope(
  source: NonNullable<ReturnType<typeof createMem0ClientFromEnv>>,
  destination: PostgresMemoryClient,
  scope: MigrationScope,
  apply: boolean,
): Promise<ScopeReport> {
  const report: ScopeReport = {
    scope,
    sourceMemories: 0,
    migrated: 0,
    alreadyPresent: 0,
    errors: [],
  };
  const memories = await listAllMemories(source, scope);
  report.sourceMemories = memories.length;
  if (!apply) return report;

  for (const record of memories) {
    try {
      const result = await destination.addMemory({
        userId: scope.userId,
        personaId: scope.personaId,
        workspaceId: scope.workspaceId,
        content: record.content,
        metadata: {
          ...record.metadata,
          workspaceId: scope.workspaceId,
          source: 'mem0-migration',
          memoryProvider: 'postgres',
          legacyProvider: 'mem0',
          legacyMem0Id: record.id,
          migratedAt: new Date().toISOString(),
        },
      });
      if (result.created === false) report.alreadyPresent += 1;
      else report.migrated += 1;
    } catch (error) {
      report.errors.push(`${record.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return report;
}

async function main(): Promise<void> {
  const apply = hasFlag('--apply');
  const requestedScope = arg('--scope');
  const scopes =
    requestedScope && requestedScope !== 'all'
      ? [parseScope(requestedScope)]
      : await discoverScopes();
  if (scopes.length === 0) {
    throw new Error(
      'No migration scopes discovered. Provide --scope userId:personaId[:workspaceId] or set WORLD_MODEL_MIGRATION_SCOPES.',
    );
  }

  const source = createMem0ClientFromEnv({
    ...(process.env as Record<string, string | undefined>),
    MEMORY_PROVIDER: 'mem0',
  });
  if (!source)
    throw new Error('Mem0 source is not configured; set MEM0_BASE_URL and MEM0_API_KEY.');

  if (apply) await runWorldModelMigrations();
  const destination = new PostgresMemoryClient();
  const scopeReports: ScopeReport[] = [];
  for (const scope of scopes) {
    console.log(`Migrating ${scope.userId}:${scope.personaId}:${scope.workspaceId || ''}`);
    scopeReports.push(await migrateScope(source, destination, scope, apply));
  }

  const totals = scopeReports.reduce(
    (result, current) => ({
      sourceMemories: result.sourceMemories + current.sourceMemories,
      migrated: result.migrated + current.migrated,
      alreadyPresent: result.alreadyPresent + current.alreadyPresent,
      errors: result.errors + current.errors.length,
    }),
    { sourceMemories: 0, migrated: 0, alreadyPresent: 0, errors: 0 },
  );
  const report: MigrationReport = {
    generatedAt: new Date().toISOString(),
    mode: apply ? 'apply' : 'dry-run',
    sourceProvider: 'mem0',
    destinationProvider: 'postgres',
    providerWideListSupported: false,
    coverage: {
      discoveredScopes: scopes.length,
      limitation:
        'Mem0 has no provider-wide list endpoint; only explicit or application-discovered scopes are covered.',
    },
    scopes: scopeReports,
    totals,
  };
  console.log(JSON.stringify(report, null, 2));

  const output = arg('--output');
  if (output) fs.writeFileSync(output, JSON.stringify(report, null, 2));
  await closeWorldModelDb();
  if (totals.errors > 0) process.exitCode = 1;
}

void main().catch(async (error) => {
  console.error(
    `Memory migration failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  try {
    await closeWorldModelDb();
  } catch (closeError) {
    console.error(
      `Memory migration cleanup failed: ${closeError instanceof Error ? closeError.message : String(closeError)}`,
    );
  }
  process.exitCode = 1;
});
