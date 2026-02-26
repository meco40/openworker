import type BetterSqlite3 from 'better-sqlite3';
import type { ExtensionManifestV1 } from '@/server/agent-v2/types';
import type { ExtensionRow } from './types';
import { safeJsonParse } from './utils';

export function upsertExtensionManifest(
  db: BetterSqlite3.Database,
  manifest: ExtensionManifestV1,
  enabled = true,
): void {
  const now = new Date().toISOString();
  const serialized = JSON.stringify(manifest);
  db.prepare(
    `
      INSERT INTO agent_v2_extensions (
        id, version, digest, manifest_json, enabled, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id, version, digest)
      DO UPDATE SET
        manifest_json = excluded.manifest_json,
        enabled = excluded.enabled,
        updated_at = excluded.updated_at
    `,
  ).run(manifest.id, manifest.version, manifest.digest, serialized, enabled ? 1 : 0, now, now);
}

export function listEnabledExtensionManifests(db: BetterSqlite3.Database): ExtensionManifestV1[] {
  const rows = db
    .prepare(
      `
      SELECT *
      FROM agent_v2_extensions
      WHERE enabled = 1
      ORDER BY id ASC, version ASC
    `,
    )
    .all() as ExtensionRow[];
  return rows
    .map((row) => safeJsonParse<ExtensionManifestV1>(row.manifest_json))
    .filter((row): row is ExtensionManifestV1 => Boolean(row));
}
