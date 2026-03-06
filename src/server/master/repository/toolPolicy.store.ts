import crypto from 'node:crypto';
import type { MasterSqliteDb } from '@/server/master/repository/db';
import { nowIso } from '@/server/master/repository/helpers';
import { toToolPolicy } from '@/server/master/repository/mappers';
import type { MasterToolPolicy, WorkspaceScope } from '@/server/master/types';

export function upsertToolPolicy(
  db: MasterSqliteDb,
  scope: WorkspaceScope,
  policy: Omit<MasterToolPolicy, 'id' | 'userId' | 'workspaceId' | 'createdAt' | 'updatedAt'>,
): MasterToolPolicy {
  const now = nowIso();
  db.prepare(
    `INSERT INTO master_tool_policies (
       id, user_id, workspace_id, security, ask, allowlist, updated_by, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, workspace_id) DO UPDATE SET
       security = excluded.security,
       ask = excluded.ask,
       allowlist = excluded.allowlist,
       updated_by = excluded.updated_by,
       updated_at = excluded.updated_at`,
  ).run(
    crypto.randomUUID(),
    scope.userId,
    scope.workspaceId,
    policy.security,
    policy.ask,
    JSON.stringify(policy.allowlist ?? []),
    policy.updatedBy ?? null,
    now,
    now,
  );
  return getToolPolicy(db, scope)!;
}

export function getToolPolicy(db: MasterSqliteDb, scope: WorkspaceScope): MasterToolPolicy | null {
  const row = db
    .prepare(
      `SELECT * FROM master_tool_policies
       WHERE user_id = ? AND workspace_id = ? LIMIT 1`,
    )
    .get(scope.userId, scope.workspaceId) as Record<string, unknown> | undefined;
  return row ? toToolPolicy(row) : null;
}
