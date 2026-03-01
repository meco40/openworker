import crypto from 'node:crypto';
import type { MasterSqliteDb } from '@/server/master/repository/db';
import { nowIso } from '@/server/master/repository/helpers';
import {
  toActionLedgerEntry,
  toCapabilityProposal,
  toCapabilityScore,
} from '@/server/master/repository/mappers';
import type {
  ApprovalDecision,
  MasterActionLedgerEntry,
  MasterCapabilityProposal,
  MasterCapabilityScore,
  WorkspaceScope,
} from '@/server/master/types';

export function upsertActionLedger(
  db: MasterSqliteDb,
  scope: WorkspaceScope,
  entry: Omit<MasterActionLedgerEntry, 'id' | 'userId' | 'workspaceId' | 'createdAt' | 'updatedAt'>,
): MasterActionLedgerEntry {
  const now = nowIso();
  db.prepare(
    `INSERT INTO master_action_ledger (
       id, run_id, user_id, workspace_id, step_id, action_type, idempotency_key, state, result_payload, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(idempotency_key) DO UPDATE SET
       state = excluded.state,
       result_payload = excluded.result_payload,
       updated_at = excluded.updated_at`,
  ).run(
    crypto.randomUUID(),
    entry.runId,
    scope.userId,
    scope.workspaceId,
    entry.stepId,
    entry.actionType,
    entry.idempotencyKey,
    entry.state,
    entry.resultPayload ?? null,
    now,
    now,
  );
  return getActionLedgerByKey(db, scope, entry.idempotencyKey)!;
}

export function getActionLedgerByKey(
  db: MasterSqliteDb,
  scope: WorkspaceScope,
  idempotencyKey: string,
): MasterActionLedgerEntry | null {
  const row = db
    .prepare(
      `SELECT * FROM master_action_ledger
       WHERE idempotency_key = ? AND user_id = ? AND workspace_id = ?`,
    )
    .get(idempotencyKey, scope.userId, scope.workspaceId) as Record<string, unknown> | undefined;
  return row ? toActionLedgerEntry(row) : null;
}

export function upsertApprovalRule(
  db: MasterSqliteDb,
  scope: WorkspaceScope,
  actionType: string,
  fingerprint: string,
  decision: ApprovalDecision,
): void {
  const now = nowIso();
  db.prepare(
    `INSERT INTO master_approval_rules (
       id, user_id, workspace_id, action_type, fingerprint, decision, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, workspace_id, action_type, fingerprint)
     DO UPDATE SET decision = excluded.decision, updated_at = excluded.updated_at`,
  ).run(
    crypto.randomUUID(),
    scope.userId,
    scope.workspaceId,
    actionType,
    fingerprint,
    decision,
    now,
    now,
  );
}

export function getApprovalRule(
  db: MasterSqliteDb,
  scope: WorkspaceScope,
  actionType: string,
  fingerprint: string,
): ApprovalDecision | null {
  const row = db
    .prepare(
      `SELECT decision FROM master_approval_rules
       WHERE user_id = ? AND workspace_id = ? AND action_type = ? AND fingerprint = ?`,
    )
    .get(scope.userId, scope.workspaceId, actionType, fingerprint) as
    | { decision: ApprovalDecision }
    | undefined;
  return row?.decision || null;
}

export function upsertCapabilityScore(
  db: MasterSqliteDb,
  scope: WorkspaceScope,
  capability: string,
  confidence: number,
  benchmarkSummary: string,
  lastVerifiedAt: string | null,
): MasterCapabilityScore {
  const now = nowIso();
  db.prepare(
    `INSERT INTO master_capability_scores (
       id, user_id, workspace_id, capability, confidence, last_verified_at, benchmark_summary, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, workspace_id, capability)
     DO UPDATE SET
       confidence = excluded.confidence,
       last_verified_at = excluded.last_verified_at,
       benchmark_summary = excluded.benchmark_summary,
       updated_at = excluded.updated_at`,
  ).run(
    crypto.randomUUID(),
    scope.userId,
    scope.workspaceId,
    capability,
    confidence,
    lastVerifiedAt,
    benchmarkSummary,
    now,
  );
  return listCapabilityScores(db, scope).find((entry) => entry.capability === capability)!;
}

export function listCapabilityScores(
  db: MasterSqliteDb,
  scope: WorkspaceScope,
): MasterCapabilityScore[] {
  const rows = db
    .prepare(
      `SELECT * FROM master_capability_scores
       WHERE user_id = ? AND workspace_id = ?
       ORDER BY updated_at DESC`,
    )
    .all(scope.userId, scope.workspaceId) as Array<Record<string, unknown>>;
  return rows.map(toCapabilityScore);
}

export function createCapabilityProposal(
  db: MasterSqliteDb,
  scope: WorkspaceScope,
  proposal: Omit<
    MasterCapabilityProposal,
    'id' | 'userId' | 'workspaceId' | 'createdAt' | 'updatedAt'
  >,
): MasterCapabilityProposal {
  const id = crypto.randomUUID();
  const now = nowIso();
  db.prepare(
    `INSERT INTO master_capability_proposals (
       id, user_id, workspace_id, title, capability_key, status, proposal, fallback_plan, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    scope.userId,
    scope.workspaceId,
    proposal.title,
    proposal.capabilityKey,
    proposal.status,
    proposal.proposal,
    proposal.fallbackPlan,
    now,
    now,
  );
  return listCapabilityProposals(db, scope).find((entry) => entry.id === id)!;
}

export function listCapabilityProposals(
  db: MasterSqliteDb,
  scope: WorkspaceScope,
): MasterCapabilityProposal[] {
  const rows = db
    .prepare(
      `SELECT * FROM master_capability_proposals
       WHERE user_id = ? AND workspace_id = ?
       ORDER BY updated_at DESC`,
    )
    .all(scope.userId, scope.workspaceId) as Array<Record<string, unknown>>;
  return rows.map(toCapabilityProposal);
}
