import crypto from 'node:crypto';
import type { MasterSqliteDb } from '@/server/master/repository/db';
import { nowIso, type SqlPatch } from '@/server/master/repository/helpers';
import { toFeedback, toRun, toStep } from '@/server/master/repository/mappers';
import type {
  MasterFeedback,
  MasterRun,
  MasterRunCreateInput,
  MasterStep,
  WorkspaceScope,
} from '@/server/master/types';

export function getRunRow(
  db: MasterSqliteDb,
  scope: WorkspaceScope,
  runId: string,
): Record<string, unknown> | undefined {
  return db
    .prepare('SELECT * FROM master_runs WHERE id = ? AND user_id = ? AND workspace_id = ?')
    .get(runId, scope.userId, scope.workspaceId) as Record<string, unknown> | undefined;
}

export function createRun(db: MasterSqliteDb, input: MasterRunCreateInput): MasterRun {
  const id = crypto.randomUUID();
  const now = nowIso();
  db.prepare(
    `INSERT INTO master_runs (
       id, user_id, workspace_id, title, contract, status, progress, verification_passed,
       result_bundle, last_error, paused_for_approval, cancelled_at, cancel_reason,
       owner_id, lease_expires_at, heartbeat_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, 'ANALYZING', 0, 0, NULL, NULL, 0, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
  ).run(id, input.userId, input.workspaceId, input.title, input.contract, now, now);
  return getRun(db, { userId: input.userId, workspaceId: input.workspaceId }, id)!;
}

export function getRun(db: MasterSqliteDb, scope: WorkspaceScope, runId: string): MasterRun | null {
  const row = getRunRow(db, scope, runId);
  return row ? toRun(row) : null;
}

export function listRuns(db: MasterSqliteDb, scope: WorkspaceScope, limit = 50): MasterRun[] {
  const rows = db
    .prepare(
      `SELECT * FROM master_runs
       WHERE user_id = ? AND workspace_id = ?
       ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(scope.userId, scope.workspaceId, limit) as Array<Record<string, unknown>>;
  return rows.map(toRun);
}

export function updateRun(
  db: MasterSqliteDb,
  scope: WorkspaceScope,
  runId: string,
  patch: Partial<MasterRun>,
): MasterRun | null {
  const updates: string[] = [];
  const values: unknown[] = [];
  const map: Record<string, string> = {
    title: 'title',
    contract: 'contract',
    status: 'status',
    progress: 'progress',
    verificationPassed: 'verification_passed',
    resultBundle: 'result_bundle',
    lastError: 'last_error',
    pausedForApproval: 'paused_for_approval',
    pendingApprovalActionType: 'pending_approval_action_type',
    cancelledAt: 'cancelled_at',
    cancelReason: 'cancel_reason',
    ownerId: 'owner_id',
    leaseExpiresAt: 'lease_expires_at',
    heartbeatAt: 'heartbeat_at',
  };
  for (const [key, column] of Object.entries(map)) {
    if (!(key in patch)) continue;
    updates.push(`${column} = ?`);
    const value = (patch as SqlPatch)[key];
    if (key === 'verificationPassed' || key === 'pausedForApproval') {
      values.push(value ? 1 : 0);
    } else {
      values.push(value ?? null);
    }
  }
  if (updates.length === 0) return getRun(db, scope, runId);
  updates.push('updated_at = ?');
  values.push(nowIso(), runId, scope.userId, scope.workspaceId);
  db.prepare(
    `UPDATE master_runs SET ${updates.join(', ')}
     WHERE id = ? AND user_id = ? AND workspace_id = ?`,
  ).run(...values);
  return getRun(db, scope, runId);
}

export function claimRun(
  db: MasterSqliteDb,
  scope: WorkspaceScope,
  runId: string,
  ownerId: string,
  leaseExpiresAt: string,
): MasterRun | null {
  const heartbeatAt = nowIso();
  const result = db
    .prepare(
      `UPDATE master_runs
       SET owner_id = ?, lease_expires_at = ?, heartbeat_at = ?, updated_at = ?
       WHERE id = ? AND user_id = ? AND workspace_id = ?
         AND (
           owner_id IS NULL
           OR owner_id = ?
           OR lease_expires_at IS NULL
           OR lease_expires_at <= ?
         )`,
    )
    .run(
      ownerId,
      leaseExpiresAt,
      heartbeatAt,
      heartbeatAt,
      runId,
      scope.userId,
      scope.workspaceId,
      ownerId,
      heartbeatAt,
    );
  if (result.changes === 0) {
    return null;
  }
  return getRun(db, scope, runId);
}

export function renewRunLease(
  db: MasterSqliteDb,
  scope: WorkspaceScope,
  runId: string,
  ownerId: string,
  leaseExpiresAt: string,
  heartbeatAt: string,
): MasterRun | null {
  const result = db
    .prepare(
      `UPDATE master_runs
       SET lease_expires_at = ?, heartbeat_at = ?, updated_at = ?
       WHERE id = ? AND user_id = ? AND workspace_id = ? AND owner_id = ?`,
    )
    .run(leaseExpiresAt, heartbeatAt, heartbeatAt, runId, scope.userId, scope.workspaceId, ownerId);
  if (result.changes === 0) {
    return null;
  }
  return getRun(db, scope, runId);
}

export function releaseRunLease(
  db: MasterSqliteDb,
  scope: WorkspaceScope,
  runId: string,
  ownerId: string,
): MasterRun | null {
  const updatedAt = nowIso();
  const result = db
    .prepare(
      `UPDATE master_runs
       SET owner_id = NULL, lease_expires_at = NULL, heartbeat_at = NULL, updated_at = ?
       WHERE id = ? AND user_id = ? AND workspace_id = ? AND owner_id = ?`,
    )
    .run(updatedAt, runId, scope.userId, scope.workspaceId, ownerId);
  if (result.changes === 0) {
    return null;
  }
  return getRun(db, scope, runId);
}

export function appendStep(
  db: MasterSqliteDb,
  scope: WorkspaceScope,
  runId: string,
  step: Omit<MasterStep, 'id' | 'createdAt' | 'updatedAt'>,
): MasterStep {
  const id = crypto.randomUUID();
  const now = nowIso();
  db.prepare(
    `INSERT INTO master_steps (
       id, run_id, user_id, workspace_id, seq, phase, status, input, output, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    runId,
    scope.userId,
    scope.workspaceId,
    step.seq,
    step.phase,
    step.status,
    step.input ?? null,
    step.output ?? null,
    now,
    now,
  );
  const row = db.prepare('SELECT * FROM master_steps WHERE id = ?').get(id) as Record<
    string,
    unknown
  >;
  return toStep(row);
}

export function listSteps(db: MasterSqliteDb, scope: WorkspaceScope, runId: string): MasterStep[] {
  const rows = db
    .prepare(
      `SELECT * FROM master_steps
       WHERE user_id = ? AND workspace_id = ? AND run_id = ?
       ORDER BY seq ASC`,
    )
    .all(scope.userId, scope.workspaceId, runId) as Array<Record<string, unknown>>;
  return rows.map(toStep);
}

export function addFeedback(
  db: MasterSqliteDb,
  scope: WorkspaceScope,
  feedback: Omit<MasterFeedback, 'id' | 'createdAt'>,
): MasterFeedback {
  const id = crypto.randomUUID();
  const createdAt = nowIso();
  db.prepare(
    `INSERT OR REPLACE INTO master_feedback (id, run_id, user_id, workspace_id, rating, policy, comment, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    feedback.runId,
    scope.userId,
    scope.workspaceId,
    feedback.rating,
    feedback.policy,
    feedback.comment ?? null,
    createdAt,
  );
  const row = db.prepare('SELECT * FROM master_feedback WHERE id = ?').get(id) as Record<
    string,
    unknown
  >;
  return toFeedback(row);
}
