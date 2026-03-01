import crypto from 'node:crypto';
import type { MasterSqliteDb } from '@/server/master/repository/db';
import { nowIso, type SqlPatch } from '@/server/master/repository/helpers';
import { toReminder } from '@/server/master/repository/mappers';
import type { MasterReminder, WorkspaceScope } from '@/server/master/types';

export function createReminder(
  db: MasterSqliteDb,
  scope: WorkspaceScope,
  input: Omit<MasterReminder, 'id' | 'userId' | 'workspaceId' | 'createdAt' | 'updatedAt'>,
): MasterReminder {
  const id = crypto.randomUUID();
  const now = nowIso();
  db.prepare(
    `INSERT INTO master_reminders (
       id, user_id, workspace_id, title, message, remind_at, cron_expression, status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    scope.userId,
    scope.workspaceId,
    input.title,
    input.message,
    input.remindAt,
    input.cronExpression ?? null,
    input.status,
    now,
    now,
  );
  const row = db.prepare('SELECT * FROM master_reminders WHERE id = ?').get(id) as Record<
    string,
    unknown
  >;
  return toReminder(row);
}

export function listReminders(
  db: MasterSqliteDb,
  scope: WorkspaceScope,
  limit = 100,
): MasterReminder[] {
  const rows = db
    .prepare(
      `SELECT * FROM master_reminders
       WHERE user_id = ? AND workspace_id = ?
       ORDER BY remind_at ASC LIMIT ?`,
    )
    .all(scope.userId, scope.workspaceId, limit) as Array<Record<string, unknown>>;
  return rows.map(toReminder);
}

export function updateReminder(
  db: MasterSqliteDb,
  scope: WorkspaceScope,
  reminderId: string,
  patch: Partial<MasterReminder>,
): MasterReminder | null {
  const updates: string[] = [];
  const values: unknown[] = [];
  const map: Record<string, string> = {
    title: 'title',
    message: 'message',
    remindAt: 'remind_at',
    cronExpression: 'cron_expression',
    status: 'status',
  };
  for (const [key, column] of Object.entries(map)) {
    if (!(key in patch)) continue;
    updates.push(`${column} = ?`);
    values.push((patch as SqlPatch)[key] ?? null);
  }
  if (updates.length === 0) return null;
  updates.push('updated_at = ?');
  values.push(nowIso(), reminderId, scope.userId, scope.workspaceId);
  db.prepare(
    `UPDATE master_reminders SET ${updates.join(', ')}
     WHERE id = ? AND user_id = ? AND workspace_id = ?`,
  ).run(...values);
  const row = db
    .prepare('SELECT * FROM master_reminders WHERE id = ? AND user_id = ? AND workspace_id = ?')
    .get(reminderId, scope.userId, scope.workspaceId) as Record<string, unknown> | undefined;
  return row ? toReminder(row) : null;
}

export function deleteReminder(
  db: MasterSqliteDb,
  scope: WorkspaceScope,
  reminderId: string,
): boolean {
  const result = db
    .prepare('DELETE FROM master_reminders WHERE id = ? AND user_id = ? AND workspace_id = ?')
    .run(reminderId, scope.userId, scope.workspaceId);
  return result.changes > 0;
}
