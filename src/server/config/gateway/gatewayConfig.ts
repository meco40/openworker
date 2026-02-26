import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { openSqliteDatabase } from '@/server/db/sqlite';
import {
  GATEWAY_CONFIG_DB_ROW_ID,
  GATEWAY_CONFIG_DB_TABLE_SQL,
} from './constants';
import { cloneDefaultConfig, normalizeGatewayConfig } from './normalize';
import {
  resolveGatewayConfigBackend,
  resolveGatewayConfigDbPath,
  resolveGatewayConfigPath,
  toGatewayConfigDisplayPath,
} from './paths';
import { redactGatewayConfigSecrets, restoreRedactedSecrets } from './secrets';
import {
  GatewayConfigConflictError,
  type GatewayConfig,
  type GatewayConfigSource,
  type GatewayConfigState,
  GatewayConfigValidationError,
  type GatewayConfigWarning,
} from './types';

function computeGatewayConfigRevision(config: GatewayConfig): string {
  const normalized = JSON.stringify(config);
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

async function createBackupIfPresent(configPath: string): Promise<void> {
  try {
    const currentRaw = await readFile(configPath, 'utf8');
    await writeFile(`${configPath}.bak`, currentRaw, 'utf8');
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: string }).code === 'ENOENT'
    ) {
      return;
    }
    throw error;
  }
}

export async function loadGatewayConfig(): Promise<GatewayConfigState> {
  if (resolveGatewayConfigBackend() === 'db') {
    const dbPath = resolveGatewayConfigDbPath();
    const db = openSqliteDatabase({ dbPath });
    try {
      db.exec(GATEWAY_CONFIG_DB_TABLE_SQL);
      const row = db
        .prepare('SELECT config_json FROM gateway_config_state WHERE id = ?')
        .get(GATEWAY_CONFIG_DB_ROW_ID) as { config_json?: string } | undefined;

      if (!row?.config_json) {
        const normalized = normalizeGatewayConfig(cloneDefaultConfig(), 'load');
        return {
          config: normalized.config,
          source: 'default',
          path: dbPath,
          warnings: [],
          revision: computeGatewayConfigRevision(normalized.config),
        };
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(row.config_json);
      } catch {
        throw new GatewayConfigValidationError('Gateway config row contains invalid JSON.');
      }

      const normalized = normalizeGatewayConfig(parsed, 'load');
      return {
        config: normalized.config,
        source: 'db',
        path: dbPath,
        warnings: normalized.warnings,
        revision: computeGatewayConfigRevision(normalized.config),
      };
    } finally {
      db.close();
    }
  }

  const configPath = resolveGatewayConfigPath();
  try {
    const raw = await readFile(configPath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    const normalized = normalizeGatewayConfig(parsed, 'load');
    return {
      config: normalized.config,
      source: 'file',
      path: configPath,
      warnings: normalized.warnings,
      revision: computeGatewayConfigRevision(normalized.config),
    };
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: string }).code === 'ENOENT'
    ) {
      const normalized = normalizeGatewayConfig(cloneDefaultConfig(), 'load');
      return {
        config: normalized.config,
        source: 'default',
        path: configPath,
        warnings: [],
        revision: computeGatewayConfigRevision(normalized.config),
      };
    }
    if (error instanceof SyntaxError) {
      throw new GatewayConfigValidationError('Gateway config file contains invalid JSON.');
    }
    throw error;
  }
}

export async function saveGatewayConfig(
  input: unknown,
  options?: { expectedRevision?: string },
): Promise<{
  config: GatewayConfig;
  path: string;
  source: GatewayConfigSource;
  warnings: GatewayConfigWarning[];
  revision: string;
}> {
  if (resolveGatewayConfigBackend() === 'db') {
    const dbPath = resolveGatewayConfigDbPath();
    const db = openSqliteDatabase({ dbPath });
    try {
      db.exec(GATEWAY_CONFIG_DB_TABLE_SQL);
      const row = db
        .prepare('SELECT config_json FROM gateway_config_state WHERE id = ?')
        .get(GATEWAY_CONFIG_DB_ROW_ID) as { config_json?: string } | undefined;
      const currentNormalized = row?.config_json
        ? normalizeGatewayConfig(JSON.parse(row.config_json) as unknown, 'load')
        : normalizeGatewayConfig(cloneDefaultConfig(), 'load');
      const currentRevision = computeGatewayConfigRevision(currentNormalized.config);

      const expectedRevision = String(options?.expectedRevision || '').trim();
      if (!expectedRevision || expectedRevision !== currentRevision) {
        throw new GatewayConfigConflictError(
          'Config was changed by another session. Reload and review your changes.',
          currentRevision,
        );
      }

      const restoredInput = restoreRedactedSecrets(input, currentNormalized.config);
      const normalized = normalizeGatewayConfig(restoredInput, 'save');
      const revision = computeGatewayConfigRevision(normalized.config);
      db.prepare(
        `
          INSERT INTO gateway_config_state (id, config_json, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            config_json = excluded.config_json,
            updated_at = excluded.updated_at
        `,
      ).run(GATEWAY_CONFIG_DB_ROW_ID, JSON.stringify(normalized.config), new Date().toISOString());

      return {
        config: normalized.config,
        path: dbPath,
        source: 'db',
        warnings: normalized.warnings,
        revision,
      };
    } finally {
      db.close();
    }
  }

  const current = await loadGatewayConfig();
  const expectedRevision = String(options?.expectedRevision || '').trim();
  if (!expectedRevision || expectedRevision !== current.revision) {
    throw new GatewayConfigConflictError(
      'Config was changed by another session. Reload and review your changes.',
      current.revision,
    );
  }

  const restoredInput = restoreRedactedSecrets(input, current.config);
  const normalized = normalizeGatewayConfig(restoredInput, 'save');
  const configPath = resolveGatewayConfigPath();
  const tempPath = `${configPath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;

  await mkdir(path.dirname(configPath), { recursive: true });
  await createBackupIfPresent(configPath);
  await writeFile(tempPath, `${JSON.stringify(normalized.config, null, 2)}\n`, 'utf8');
  try {
    await rename(tempPath, configPath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }

  return {
    config: normalized.config,
    path: configPath,
    source: 'file',
    warnings: normalized.warnings,
    revision: computeGatewayConfigRevision(normalized.config),
  };
}

export {
  GatewayConfigConflictError,
  GatewayConfigValidationError,
  redactGatewayConfigSecrets,
  toGatewayConfigDisplayPath,
};
export type {
  GatewayConfig,
  GatewayConfigSource,
  GatewayConfigState,
  GatewayConfigWarning,
};

