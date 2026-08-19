#!/usr/bin/env node
/**
 * World Model Rebuild Projections Script
 *
 * Phase 13: Baut alle abgeleiteten Projektionen (Embeddings, Graphiti, Mem0)
 * vollständig aus PostgreSQL neu auf. Idempotent und wiederholbar.
 *
 * Usage:
 *   pnpm run world-model:rebuild-projections -- --dry-run
 *   pnpm run world-model:rebuild-projections -- --type embeddings
 *   pnpm run world-model:rebuild-projections -- --type graphiti
 */

import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { loadEnvConfig } = require('@next/env') as {
  loadEnvConfig: (dir: string, dev?: boolean) => unknown;
};
loadEnvConfig(process.cwd());

interface RebuildOptions {
  dryRun: boolean;
  type: 'all' | 'embeddings' | 'graphiti';
  scope?: string;
  resume: boolean;
  batchSize: number;
  includeObservations: boolean;
  output?: string;
}

interface RebuildScope {
  userId: string;
  personaId: string;
  workspaceId: string;
}

function parseArgs(): RebuildOptions {
  const args = process.argv.slice(2);
  const options: RebuildOptions = {
    dryRun: false,
    type: 'all',
    resume: false,
    batchSize: 50,
    includeObservations: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--type':
        options.type = (args[++i] ?? 'all') as RebuildOptions['type'];
        break;
      case '--scope':
        options.scope = args[++i];
        break;
      case '--resume':
        options.resume = true;
        break;
      case '--batch-size':
        options.batchSize = Math.max(1, Math.min(500, Number(args[++i]) || 50));
        break;
      case '--include-observations':
        options.includeObservations = true;
        break;
      case '--output':
        options.output = args[++i];
        break;
    }
  }
  return options;
}

function parseScope(value?: string): RebuildScope | null {
  if (!value) return null;
  const parts = value.split(':');
  const userId = parts[0] ?? '';
  const personaId = parts[1] ?? '';
  const workspaceId = parts.slice(2).join(':');
  if (
    parts.length < 3 ||
    !/^[A-Za-z0-9._-]+$/.test(userId) ||
    !/^[A-Za-z0-9._-]+$/.test(personaId) ||
    !(workspaceId === '' || /^[A-Za-z0-9._:-]+$/.test(workspaceId))
  ) {
    throw new Error('--scope must be userId:personaId:workspaceId; workspaceId may contain :');
  }
  return { userId, personaId, workspaceId };
}

async function run(options: RebuildOptions): Promise<void> {
  console.log('=== World Model Rebuild Projections ===');
  console.log(`Mode: ${options.dryRun ? 'DRY RUN' : 'LIVE'}`);
  console.log(`Type: ${options.type}`);
  console.log(`Scope: ${options.scope ?? 'all'}`);
  console.log(`Resume: ${options.resume}`);
  console.log(`Batch size: ${options.batchSize}`);
  console.log(`Include raw observations: ${options.includeObservations}`);
  console.log('');

  let report: Record<string, unknown> | null = null;
  try {
    const { getWorldModelConfig } = await import('@/server/world-model/config');
    const config = getWorldModelConfig();
    if (!config.enabled && !config.e2eEnabled) {
      throw new Error('World Model is disabled; refusing to report a rebuild as complete.');
    }

    const { getWorldModelDb, runWorldModelMigrations, closeWorldModelDb, runWithWorldModelScope } =
      await import('@/server/world-model/db');
    await runWorldModelMigrations();
    const db = getWorldModelDb();
    const scope = parseScope(options.scope);
    if (!options.dryRun && !scope) {
      throw new Error(
        'A live rebuild requires --scope userId:personaId:workspaceId so RLS cannot turn an unscoped run into a false success.',
      );
    }

    report = {
      generatedAt: new Date().toISOString(),
      type: options.type,
      scope: options.scope ?? null,
      dryRun: options.dryRun,
      resume: options.resume,
      batchSize: options.batchSize,
      includeObservations: options.includeObservations,
      phases: {},
      ok: false,
    };
    const activeReport = report;

    const runScoped = <T>(callback: () => Promise<T>): Promise<T> =>
      scope ? runWithWorldModelScope(scope, callback) : callback();

    await runScoped(async () => {
      if (options.type === 'all' || options.type === 'embeddings') {
        console.log('--- Rebuilding Embeddings ---');
        if (options.dryRun) {
          console.log(
            `[DRY RUN] Would delete and regenerate ${scope ? `embeddings for ${options.scope}` : 'all embeddings'}`,
          );
        } else {
          const { getConfiguredEmbeddingProvider } =
            await import('@/server/world-model/embeddings/provider');
          const provider = getConfiguredEmbeddingProvider();
          if (!provider) {
            throw new Error(
              'No configured embedding provider is available; existing embeddings were not rebuilt.',
            );
          }
          // Alte Embeddings löschen
          const deleteResult = scope
            ? await db.query(
                `DELETE FROM world_model_embeddings
               WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3`,
                [scope.userId, scope.personaId, scope.workspaceId],
              )
            : await db.query('DELETE FROM world_model_embeddings');
          console.log(`  Deleted existing embeddings: ${deleteResult.rowCount ?? 0}`);
          // Drain all available batches for the selected scope. A provider
          // failure stops the drain instead of pretending the rebuild finished.
          const { collectEmbeddingTargets, processEmbeddingBatch } =
            await import('@/server/world-model/embeddings/embeddingWorker');
          const targets = await collectEmbeddingTargets(10_000, scope ?? undefined);
          let collected = 0;
          let processed = 0;
          let created = 0;
          for (let offset = 0; offset < targets.length; offset += options.batchSize) {
            const result = await processEmbeddingBatch(
              targets.slice(offset, offset + options.batchSize),
              {
                model: provider.model,
                modelVersion: provider.modelVersion,
              },
            );
            collected += Math.min(options.batchSize, targets.length - offset);
            processed += result.length;
            created += result.filter((entry) => entry.created).length;
          }
          const phase = { collected, processed, created };
          activeReport.phases = {
            ...(activeReport.phases as Record<string, unknown>),
            embeddings: phase,
          };
          console.log(`  Embedded: ${JSON.stringify(phase)}`);
          if (collected > processed) {
            throw new Error(
              `Embedding rebuild incomplete: collected=${collected}, processed=${processed}.`,
            );
          }
        }
      }

      if (options.type === 'all' || options.type === 'graphiti') {
        console.log('--- Rebuilding Graphiti ---');
        if (options.dryRun) {
          console.log('[DRY RUN] Would clear graphiti scope and re-project from PostgreSQL');
        } else {
          const { clearGraphitiScope } = await import('@/server/world-model/graphiti/client');
          const { rebuildGraphitiFromPostgres } =
            await import('@/server/world-model/graphiti/projector');
          if (!scope) {
            console.log('  [SKIP] Graphiti rebuild requires --scope userId:personaId:workspaceId');
          } else {
            if (!options.resume) {
              await clearGraphitiScope(scope.userId, scope.personaId, scope.workspaceId);
            }
            const result = await rebuildGraphitiFromPostgres({
              ...scope,
              resume: options.resume,
              batchSize: options.batchSize,
              includeObservations: options.includeObservations,
            });
            activeReport.phases = {
              ...(activeReport.phases as Record<string, unknown>),
              graphiti: result,
            };
            console.log(`  Rebuilt: ${JSON.stringify(result)}`);
          }
        }
      }
    });

    activeReport.ok = true;
    activeReport.finishedAt = new Date().toISOString();
    if (options.output) {
      fs.writeFileSync(options.output, JSON.stringify(report, null, 2));
      console.log(`Report written to ${options.output}`);
    }
    console.log('');
    console.log('Rebuild complete.');
    await closeWorldModelDb().catch(() => {});
  } catch (error) {
    if (options.output && report) {
      report.ok = false;
      report.error = error instanceof Error ? error.message : String(error);
      report.finishedAt = new Date().toISOString();
      fs.writeFileSync(options.output, JSON.stringify(report, null, 2));
      console.error(`Failure report written to ${options.output}`);
    }
    console.error('Rebuild failed:', error);
    process.exit(1);
  }
}

const options = parseArgs();
void run(options);
