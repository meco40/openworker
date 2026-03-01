import crypto from 'node:crypto';
import type { MasterSqliteDb } from '@/server/master/repository/db';
import { nowIso, type SqlPatch } from '@/server/master/repository/helpers';
import { toToolForgeArtifact } from '@/server/master/repository/mappers';
import type { MasterToolForgeArtifact, WorkspaceScope } from '@/server/master/types';

export function createToolForgeArtifact(
  db: MasterSqliteDb,
  scope: WorkspaceScope,
  artifact: Omit<
    MasterToolForgeArtifact,
    'id' | 'userId' | 'workspaceId' | 'createdAt' | 'updatedAt'
  >,
): MasterToolForgeArtifact {
  const id = crypto.randomUUID();
  const now = nowIso();
  db.prepare(
    `INSERT INTO master_toolforge_artifacts (
       id, user_id, workspace_id, name, spec, manifest, test_summary, risk_report, status, published_globally, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    scope.userId,
    scope.workspaceId,
    artifact.name,
    artifact.spec,
    artifact.manifest,
    artifact.testSummary,
    artifact.riskReport,
    artifact.status,
    artifact.publishedGlobally ? 1 : 0,
    now,
    now,
  );
  return listToolForgeArtifacts(db, scope).find((entry) => entry.id === id)!;
}

export function updateToolForgeArtifact(
  db: MasterSqliteDb,
  scope: WorkspaceScope,
  artifactId: string,
  patch: Partial<MasterToolForgeArtifact>,
): MasterToolForgeArtifact | null {
  const updates: string[] = [];
  const values: unknown[] = [];
  const map: Record<string, string> = {
    name: 'name',
    spec: 'spec',
    manifest: 'manifest',
    testSummary: 'test_summary',
    riskReport: 'risk_report',
    status: 'status',
    publishedGlobally: 'published_globally',
  };
  for (const [key, column] of Object.entries(map)) {
    if (!(key in patch)) continue;
    updates.push(`${column} = ?`);
    if (key === 'publishedGlobally') {
      values.push((patch as SqlPatch)[key] ? 1 : 0);
    } else {
      values.push((patch as SqlPatch)[key] ?? null);
    }
  }
  if (updates.length === 0) return null;
  updates.push('updated_at = ?');
  values.push(nowIso(), artifactId, scope.userId, scope.workspaceId);
  db.prepare(
    `UPDATE master_toolforge_artifacts SET ${updates.join(', ')}
     WHERE id = ? AND user_id = ? AND workspace_id = ?`,
  ).run(...values);
  return listToolForgeArtifacts(db, scope).find((entry) => entry.id === artifactId) || null;
}

export function listToolForgeArtifacts(
  db: MasterSqliteDb,
  scope: WorkspaceScope,
): MasterToolForgeArtifact[] {
  const rows = db
    .prepare(
      `SELECT * FROM master_toolforge_artifacts
       WHERE user_id = ? AND workspace_id = ?
       ORDER BY updated_at DESC`,
    )
    .all(scope.userId, scope.workspaceId) as Array<Record<string, unknown>>;
  return rows.map(toToolForgeArtifact);
}

export function listGlobalToolForgeArtifacts(
  db: MasterSqliteDb,
  limit = 200,
): MasterToolForgeArtifact[] {
  const rows = db
    .prepare(
      `SELECT * FROM master_toolforge_artifacts
       WHERE published_globally = 1 AND status = 'published'
       ORDER BY updated_at DESC
       LIMIT ?`,
    )
    .all(limit) as Array<Record<string, unknown>>;
  return rows.map(toToolForgeArtifact);
}
