import crypto from 'node:crypto';
import type { MasterSqliteDb } from '@/server/master/repository/db';
import { nowIso, type SqlPatch } from '@/server/master/repository/helpers';
import { toApprovalRequest } from '@/server/master/repository/mappers';
import type { MasterApprovalRequest, WorkspaceScope } from '@/server/master/types';

export function createApprovalRequest(
  db: MasterSqliteDb,
  scope: WorkspaceScope,
  request: Omit<MasterApprovalRequest, 'id' | 'userId' | 'workspaceId' | 'createdAt' | 'updatedAt'>,
): MasterApprovalRequest {
  const id = crypto.randomUUID();
  const now = nowIso();
  db.prepare(
    `INSERT INTO master_approval_requests (
       id, run_id, step_id, user_id, workspace_id, tool_name, action_type, summary, prompt, host,
       cwd, resolved_path, fingerprint, risk_level, status, expires_at, decision, decision_reason,
       decided_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    request.runId,
    request.stepId,
    scope.userId,
    scope.workspaceId,
    request.toolName,
    request.actionType,
    request.summary,
    request.prompt,
    request.host ?? null,
    request.cwd ?? null,
    request.resolvedPath ?? null,
    request.fingerprint,
    request.riskLevel,
    request.status,
    request.expiresAt,
    request.decision ?? null,
    request.decisionReason ?? null,
    request.decidedAt ?? null,
    now,
    now,
  );
  return getApprovalRequest(db, scope, id)!;
}

export function updateApprovalRequest(
  db: MasterSqliteDb,
  scope: WorkspaceScope,
  requestId: string,
  patch: Partial<MasterApprovalRequest>,
): MasterApprovalRequest | null {
  const updates: string[] = [];
  const values: unknown[] = [];
  const map: Record<string, string> = {
    stepId: 'step_id',
    toolName: 'tool_name',
    actionType: 'action_type',
    summary: 'summary',
    prompt: 'prompt',
    host: 'host',
    cwd: 'cwd',
    resolvedPath: 'resolved_path',
    fingerprint: 'fingerprint',
    riskLevel: 'risk_level',
    status: 'status',
    expiresAt: 'expires_at',
    decision: 'decision',
    decisionReason: 'decision_reason',
    decidedAt: 'decided_at',
  };
  for (const [key, column] of Object.entries(map)) {
    if (!(key in patch)) continue;
    updates.push(`${column} = ?`);
    values.push((patch as SqlPatch)[key] ?? null);
  }
  if (updates.length === 0) return getApprovalRequest(db, scope, requestId);
  updates.push('updated_at = ?');
  values.push(nowIso(), requestId, scope.userId, scope.workspaceId);
  db.prepare(
    `UPDATE master_approval_requests SET ${updates.join(', ')}
     WHERE id = ? AND user_id = ? AND workspace_id = ?`,
  ).run(...values);
  return getApprovalRequest(db, scope, requestId);
}

export function getApprovalRequest(
  db: MasterSqliteDb,
  scope: WorkspaceScope,
  requestId: string,
): MasterApprovalRequest | null {
  const row = db
    .prepare(
      `SELECT * FROM master_approval_requests
       WHERE id = ? AND user_id = ? AND workspace_id = ?`,
    )
    .get(requestId, scope.userId, scope.workspaceId) as Record<string, unknown> | undefined;
  return row ? toApprovalRequest(row) : null;
}

export function listApprovalRequests(
  db: MasterSqliteDb,
  scope: WorkspaceScope,
  runId?: string,
  limit = 200,
): MasterApprovalRequest[] {
  const rows = (
    runId
      ? db
          .prepare(
            `SELECT * FROM master_approval_requests
             WHERE user_id = ? AND workspace_id = ? AND run_id = ?
             ORDER BY updated_at DESC LIMIT ?`,
          )
          .all(scope.userId, scope.workspaceId, runId, limit)
      : db
          .prepare(
            `SELECT * FROM master_approval_requests
             WHERE user_id = ? AND workspace_id = ?
             ORDER BY updated_at DESC LIMIT ?`,
          )
          .all(scope.userId, scope.workspaceId, limit)
  ) as Array<Record<string, unknown>>;
  return rows.map(toApprovalRequest);
}
