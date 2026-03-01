import crypto from 'node:crypto';
import type { MasterSqliteDb } from '@/server/master/repository/db';
import { nowIso } from '@/server/master/repository/helpers';
import { toAuditEvent } from '@/server/master/repository/mappers';
import type { MasterAuditEvent, WorkspaceScope } from '@/server/master/types';

export function appendAuditEvent(
  db: MasterSqliteDb,
  scope: WorkspaceScope,
  input: Omit<MasterAuditEvent, 'id' | 'userId' | 'workspaceId' | 'createdAt'>,
): MasterAuditEvent {
  const id = crypto.randomUUID();
  const createdAt = nowIso();
  db.prepare(
    `INSERT INTO master_audit_events (
       id, user_id, workspace_id, category, action, metadata, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    scope.userId,
    scope.workspaceId,
    input.category,
    input.action,
    input.metadata,
    createdAt,
  );
  return {
    id,
    userId: scope.userId,
    workspaceId: scope.workspaceId,
    category: input.category,
    action: input.action,
    metadata: input.metadata,
    createdAt,
  };
}

export function listAuditEvents(
  db: MasterSqliteDb,
  scope: WorkspaceScope,
  limit = 200,
): MasterAuditEvent[] {
  const rows = db
    .prepare(
      `SELECT * FROM master_audit_events
       WHERE user_id = ? AND workspace_id = ?
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(scope.userId, scope.workspaceId, limit) as Array<Record<string, unknown>>;
  return rows.map(toAuditEvent);
}
