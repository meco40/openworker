#!/usr/bin/env node
/**
 * Scoped World-Model export/restore evidence tool.
 *
 * External Mem0/Graphiti data is intentionally not guessed or silently
 * restored. After a canonical restore, the caller must run the provider-
 * specific projection rebuilds and verify them separately.
 */

import fs from 'node:fs';

interface Scope {
  userId: string;
  personaId: string;
  workspaceId: string;
}

function parseArgs(): {
  scope?: string;
  exportPath?: string;
  restorePath?: string;
  replace: boolean;
  dryRun: boolean;
} {
  const args = process.argv.slice(2);
  const options = { replace: false, dryRun: false } as ReturnType<typeof parseArgs>;
  for (let index = 0; index < args.length; index += 1) {
    switch (args[index]) {
      case '--scope':
        options.scope = args[++index];
        break;
      case '--export':
        options.exportPath = args[++index];
        break;
      case '--restore':
        options.restorePath = args[++index];
        break;
      case '--replace':
        options.replace = true;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
    }
  }
  return options;
}

function parseScope(value?: string): Scope {
  if (!value) throw new Error('--scope userId:personaId:workspaceId is required.');
  const parts = value.split(':');
  const workspaceId = parts.slice(2).join(':');
  if (
    parts.length < 3 ||
    !/^[A-Za-z0-9._-]+$/.test(parts[0] ?? '') ||
    !/^[A-Za-z0-9._-]+$/.test(parts[1] ?? '') ||
    !(workspaceId === '' || /^[A-Za-z0-9._:-]+$/.test(workspaceId))
  ) {
    throw new Error('--scope must be userId:personaId:workspaceId; workspaceId may contain :.');
  }
  return { userId: parts[0]!, personaId: parts[1]!, workspaceId };
}

async function main(): Promise<void> {
  const options = parseArgs();
  if (
    (!options.exportPath && !options.restorePath) ||
    (options.exportPath && options.restorePath)
  ) {
    throw new Error('Choose exactly one of --export or --restore.');
  }
  const scope = parseScope(options.scope);
  const {
    closeWorldModelDb,
    deleteWorldModelScope,
    exportWorldModelScope,
    restoreWorldModelScope,
    runWorldModelMigrations,
  } = await import('@/server/world-model/worldModel');
  await runWorldModelMigrations();

  if (options.exportPath) {
    const exported = await exportWorldModelScope(scope);
    if (!options.dryRun) {
      fs.writeFileSync(options.exportPath, JSON.stringify(exported, null, 2));
    }
    console.log(
      JSON.stringify(
        {
          operation: 'export',
          dryRun: options.dryRun,
          scope,
          manifestHash: exported.manifestHash,
          tables: Object.fromEntries(
            Object.entries(exported.tables).map(([table, rows]) => [table, rows.length]),
          ),
          output: options.dryRun ? null : options.exportPath,
        },
        null,
        2,
      ),
    );
  } else {
    const exported = JSON.parse(fs.readFileSync(options.restorePath!, 'utf8'));
    if (options.dryRun) {
      console.log(
        JSON.stringify(
          { operation: 'restore', dryRun: true, scope, manifestHash: exported.manifestHash },
          null,
          2,
        ),
      );
    } else {
      if (options.replace) await deleteWorldModelScope(scope);
      const restored = await restoreWorldModelScope(scope, exported);
      console.log(
        JSON.stringify(
          {
            operation: 'restore',
            dryRun: false,
            ...restored,
            externalProjectionRebuildRequired: ['embeddings', 'graphiti', 'mem0'],
          },
          null,
          2,
        ),
      );
    }
  }
  await closeWorldModelDb();
}

void main().catch((error) => {
  console.error(
    `World Model lifecycle failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
