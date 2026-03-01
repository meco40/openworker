import crypto from 'node:crypto';
import type { MasterSqliteDb } from '@/server/master/repository/db';
import { nowIso } from '@/server/master/repository/helpers';
import { toNote } from '@/server/master/repository/mappers';
import type { MasterNote, WorkspaceScope } from '@/server/master/types';

export function createNote(
  db: MasterSqliteDb,
  scope: WorkspaceScope,
  input: Omit<MasterNote, 'id' | 'userId' | 'workspaceId' | 'createdAt' | 'updatedAt'>,
): MasterNote {
  const id = crypto.randomUUID();
  const now = nowIso();
  db.prepare(
    `INSERT INTO master_notes (
       id, user_id, workspace_id, title, content, tags, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    scope.userId,
    scope.workspaceId,
    input.title,
    input.content,
    JSON.stringify(input.tags || []),
    now,
    now,
  );
  const row = db.prepare('SELECT * FROM master_notes WHERE id = ?').get(id) as Record<
    string,
    unknown
  >;
  return toNote(row);
}

export function listNotes(db: MasterSqliteDb, scope: WorkspaceScope, limit = 100): MasterNote[] {
  const rows = db
    .prepare(
      `SELECT * FROM master_notes
       WHERE user_id = ? AND workspace_id = ?
       ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(scope.userId, scope.workspaceId, limit) as Array<Record<string, unknown>>;
  return rows.map(toNote);
}

export function updateNote(
  db: MasterSqliteDb,
  scope: WorkspaceScope,
  noteId: string,
  patch: Partial<Pick<MasterNote, 'title' | 'content' | 'tags'>>,
): MasterNote | null {
  const updates: string[] = [];
  const values: unknown[] = [];
  if (patch.title !== undefined) {
    updates.push('title = ?');
    values.push(patch.title);
  }
  if (patch.content !== undefined) {
    updates.push('content = ?');
    values.push(patch.content);
  }
  if (patch.tags !== undefined) {
    updates.push('tags = ?');
    values.push(JSON.stringify(patch.tags));
  }
  if (updates.length === 0) return null;
  updates.push('updated_at = ?');
  values.push(nowIso(), noteId, scope.userId, scope.workspaceId);
  db.prepare(
    `UPDATE master_notes SET ${updates.join(', ')}
     WHERE id = ? AND user_id = ? AND workspace_id = ?`,
  ).run(...values);
  const row = db
    .prepare('SELECT * FROM master_notes WHERE id = ? AND user_id = ? AND workspace_id = ?')
    .get(noteId, scope.userId, scope.workspaceId) as Record<string, unknown> | undefined;
  return row ? toNote(row) : null;
}

export function deleteNote(db: MasterSqliteDb, scope: WorkspaceScope, noteId: string): boolean {
  const result = db
    .prepare('DELETE FROM master_notes WHERE id = ? AND user_id = ? AND workspace_id = ?')
    .run(noteId, scope.userId, scope.workspaceId);
  return result.changes > 0;
}
