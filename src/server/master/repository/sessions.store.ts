import crypto from 'node:crypto';
import type { MasterSqliteDb } from '@/server/master/repository/db';
import { nowIso, type SqlPatch } from '@/server/master/repository/helpers';
import { toSubagentSession } from '@/server/master/repository/mappers';
import type { MasterSubagentSession, WorkspaceScope } from '@/server/master/types';

export function createSubagentSession(
  db: MasterSqliteDb,
  scope: WorkspaceScope,
  session: Omit<MasterSubagentSession, 'id' | 'userId' | 'workspaceId' | 'createdAt' | 'updatedAt'>,
): MasterSubagentSession {
  const id = crypto.randomUUID();
  const now = nowIso();
  db.prepare(
    `INSERT INTO master_subagent_sessions (
       id, run_id, user_id, workspace_id, status, title, prompt, assigned_tools, owner_id,
       lease_expires_at, heartbeat_at, latest_event_at, result_summary, last_error, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    session.runId,
    scope.userId,
    scope.workspaceId,
    session.status,
    session.title,
    session.prompt,
    JSON.stringify(session.assignedTools ?? []),
    session.ownerId ?? null,
    session.leaseExpiresAt ?? null,
    session.heartbeatAt ?? null,
    session.latestEventAt ?? null,
    session.resultSummary ?? null,
    session.lastError ?? null,
    now,
    now,
  );
  return getSubagentSession(db, scope, id)!;
}

export function updateSubagentSession(
  db: MasterSqliteDb,
  scope: WorkspaceScope,
  sessionId: string,
  patch: Partial<MasterSubagentSession>,
): MasterSubagentSession | null {
  const updates: string[] = [];
  const values: unknown[] = [];
  const map: Record<string, string> = {
    status: 'status',
    title: 'title',
    prompt: 'prompt',
    assignedTools: 'assigned_tools',
    ownerId: 'owner_id',
    leaseExpiresAt: 'lease_expires_at',
    heartbeatAt: 'heartbeat_at',
    latestEventAt: 'latest_event_at',
    resultSummary: 'result_summary',
    lastError: 'last_error',
  };
  for (const [key, column] of Object.entries(map)) {
    if (!(key in patch)) continue;
    updates.push(`${column} = ?`);
    const rawValue = (patch as SqlPatch)[key];
    values.push(key === 'assignedTools' ? JSON.stringify(rawValue ?? []) : (rawValue ?? null));
  }
  if (updates.length === 0) return getSubagentSession(db, scope, sessionId);
  updates.push('updated_at = ?');
  values.push(nowIso(), sessionId, scope.userId, scope.workspaceId);
  db.prepare(
    `UPDATE master_subagent_sessions SET ${updates.join(', ')}
     WHERE id = ? AND user_id = ? AND workspace_id = ?`,
  ).run(...values);
  return getSubagentSession(db, scope, sessionId);
}

export function getSubagentSession(
  db: MasterSqliteDb,
  scope: WorkspaceScope,
  sessionId: string,
): MasterSubagentSession | null {
  const row = db
    .prepare(
      `SELECT * FROM master_subagent_sessions
       WHERE id = ? AND user_id = ? AND workspace_id = ?`,
    )
    .get(sessionId, scope.userId, scope.workspaceId) as Record<string, unknown> | undefined;
  return row ? toSubagentSession(row) : null;
}

export function listSubagentSessions(
  db: MasterSqliteDb,
  scope: WorkspaceScope,
  runId?: string,
  limit = 200,
): MasterSubagentSession[] {
  const rows = (
    runId
      ? db
          .prepare(
            `SELECT * FROM master_subagent_sessions
             WHERE user_id = ? AND workspace_id = ? AND run_id = ?
             ORDER BY updated_at DESC LIMIT ?`,
          )
          .all(scope.userId, scope.workspaceId, runId, limit)
      : db
          .prepare(
            `SELECT * FROM master_subagent_sessions
             WHERE user_id = ? AND workspace_id = ?
             ORDER BY updated_at DESC LIMIT ?`,
          )
          .all(scope.userId, scope.workspaceId, limit)
  ) as Array<Record<string, unknown>>;
  return rows.map(toSubagentSession);
}
