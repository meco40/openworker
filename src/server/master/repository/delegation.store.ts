import crypto from 'node:crypto';
import type { MasterSqliteDb } from '@/server/master/repository/db';
import { nowIso, type SqlPatch } from '@/server/master/repository/helpers';
import { toDelegationEvent, toDelegationJob } from '@/server/master/repository/mappers';
import type {
  MasterDelegationEvent,
  MasterDelegationJob,
  WorkspaceScope,
} from '@/server/master/types';

export function createDelegationJob(
  db: MasterSqliteDb,
  scope: WorkspaceScope,
  job: Omit<
    MasterDelegationJob,
    'id' | 'userId' | 'workspaceId' | 'createdAt' | 'updatedAt' | 'attempts' | 'lastError'
  >,
): MasterDelegationJob {
  const id = crypto.randomUUID();
  const now = nowIso();
  db.prepare(
    `INSERT INTO master_subagent_jobs (
       id, run_id, user_id, workspace_id, capability, payload, status, priority,
       attempts, max_attempts, timeout_ms, last_error, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL, ?, ?)`,
  ).run(
    id,
    job.runId,
    scope.userId,
    scope.workspaceId,
    job.capability,
    job.payload,
    job.status,
    job.priority,
    job.maxAttempts,
    job.timeoutMs,
    now,
    now,
  );
  return listDelegationJobs(db, scope, job.runId).find((entry) => entry.id === id)!;
}

export function updateDelegationJob(
  db: MasterSqliteDb,
  scope: WorkspaceScope,
  jobId: string,
  patch: Partial<MasterDelegationJob>,
): MasterDelegationJob | null {
  const updates: string[] = [];
  const values: unknown[] = [];
  const map: Record<string, string> = {
    status: 'status',
    attempts: 'attempts',
    lastError: 'last_error',
    payload: 'payload',
    priority: 'priority',
    timeoutMs: 'timeout_ms',
    maxAttempts: 'max_attempts',
  };
  for (const [key, column] of Object.entries(map)) {
    if (!(key in patch)) continue;
    updates.push(`${column} = ?`);
    values.push((patch as SqlPatch)[key] ?? null);
  }
  if (updates.length === 0) return null;
  updates.push('updated_at = ?');
  values.push(nowIso(), jobId, scope.userId, scope.workspaceId);
  db.prepare(
    `UPDATE master_subagent_jobs SET ${updates.join(', ')}
     WHERE id = ? AND user_id = ? AND workspace_id = ?`,
  ).run(...values);
  const row = db
    .prepare('SELECT * FROM master_subagent_jobs WHERE id = ? AND user_id = ? AND workspace_id = ?')
    .get(jobId, scope.userId, scope.workspaceId) as Record<string, unknown> | undefined;
  return row ? toDelegationJob(row) : null;
}

export function listDelegationJobs(
  db: MasterSqliteDb,
  scope: WorkspaceScope,
  runId: string,
): MasterDelegationJob[] {
  const rows = db
    .prepare(
      `SELECT * FROM master_subagent_jobs
       WHERE user_id = ? AND workspace_id = ? AND run_id = ?
       ORDER BY created_at ASC`,
    )
    .all(scope.userId, scope.workspaceId, runId) as Array<Record<string, unknown>>;
  return rows.map((row) => toDelegationJob(row));
}

export function appendDelegationEvent(
  db: MasterSqliteDb,
  scope: WorkspaceScope,
  event: Omit<MasterDelegationEvent, 'id' | 'userId' | 'workspaceId' | 'createdAt'>,
): MasterDelegationEvent {
  const id = crypto.randomUUID();
  const createdAt = nowIso();
  db.prepare(
    `INSERT INTO master_subagent_events (
       id, job_id, run_id, user_id, workspace_id, type, payload, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    event.jobId,
    event.runId,
    scope.userId,
    scope.workspaceId,
    event.type,
    event.payload,
    createdAt,
  );
  return {
    id,
    jobId: event.jobId,
    runId: event.runId,
    userId: scope.userId,
    workspaceId: scope.workspaceId,
    type: event.type,
    payload: event.payload,
    createdAt,
  };
}

export function listDelegationEvents(
  db: MasterSqliteDb,
  scope: WorkspaceScope,
  runId: string,
): MasterDelegationEvent[] {
  const rows = db
    .prepare(
      `SELECT * FROM master_subagent_events
       WHERE user_id = ? AND workspace_id = ? AND run_id = ?
       ORDER BY created_at ASC`,
    )
    .all(scope.userId, scope.workspaceId, runId) as Array<Record<string, unknown>>;
  return rows.map(toDelegationEvent);
}
