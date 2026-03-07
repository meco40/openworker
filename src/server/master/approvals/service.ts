import type { MasterRepository } from '@/server/master/repository';
import type {
  ApprovalDecision,
  MasterApprovalRequest,
  WorkspaceScope,
} from '@/server/master/types';
import { publishMasterUpdated } from '@/server/master/liveEvents';

const DEFAULT_APPROVAL_TTL_MS = 5 * 60 * 1000;

function buildPrompt(summary: string, actionType: string): string {
  return `Approval required for ${actionType}: ${summary}`;
}

function buildDecisionReason(decision: ApprovalDecision): string {
  switch (decision) {
    case 'approve_always':
      return 'Approved and persisted for future matching actions.';
    case 'approve_once':
      return 'Approved for a single matching action.';
    case 'deny':
      return 'Action denied by operator.';
  }
}

export function createPendingApprovalRequest(input: {
  repo: MasterRepository;
  scope: WorkspaceScope;
  runId: string;
  stepId: string;
  actionType: string;
  summary: string;
  host: MasterApprovalRequest['host'];
  cwd?: string | null;
  resolvedPath?: string | null;
  fingerprint: string;
  riskLevel: MasterApprovalRequest['riskLevel'];
  toolName?: string;
  prompt?: string;
  expiresAt?: string;
}): MasterApprovalRequest {
  const existing = input.repo
    .listApprovalRequests(input.scope, input.runId)
    .find(
      (request) =>
        request.status === 'pending' &&
        request.actionType === input.actionType &&
        request.fingerprint === input.fingerprint,
    );
  if (existing) {
    return existing;
  }

  const request = input.repo.createApprovalRequest(input.scope, {
    runId: input.runId,
    stepId: input.stepId,
    toolName: input.toolName ?? input.actionType,
    actionType: input.actionType,
    summary: input.summary,
    prompt: input.prompt ?? buildPrompt(input.summary, input.actionType),
    host: input.host,
    cwd: input.cwd ?? null,
    resolvedPath: input.resolvedPath ?? null,
    fingerprint: input.fingerprint,
    riskLevel: input.riskLevel,
    status: 'pending',
    expiresAt: input.expiresAt ?? new Date(Date.now() + DEFAULT_APPROVAL_TTL_MS).toISOString(),
    decision: null,
    decisionReason: null,
    decidedAt: null,
  });

  input.repo.updateRun(input.scope, input.runId, {
    status: 'AWAITING_APPROVAL',
    pausedForApproval: true,
    pendingApprovalActionType: input.actionType,
    lastError: request.prompt,
  });
  input.repo.appendAuditEvent(input.scope, {
    category: 'approval',
    action: 'request_created',
    metadata: JSON.stringify({
      requestId: request.id,
      runId: input.runId,
      actionType: input.actionType,
      fingerprint: input.fingerprint,
    }),
  });
  publishMasterUpdated({
    scope: input.scope,
    resources: ['approvals', 'runs', 'metrics', 'run_detail'],
    runId: input.runId,
    approvalRequestId: request.id,
  });
  return request;
}

export function applyApprovalDecision(input: {
  repo: MasterRepository;
  scope: WorkspaceScope;
  requestId: string;
  decision: ApprovalDecision;
}): MasterApprovalRequest {
  const request = input.repo.getApprovalRequest(input.scope, input.requestId);
  if (!request) {
    throw new Error('Approval request not found.');
  }

  const decidedAt = new Date().toISOString();
  const status = input.decision === 'deny' ? 'denied' : 'approved';
  const updated = input.repo.updateApprovalRequest(input.scope, input.requestId, {
    status,
    decision: input.decision,
    decisionReason: buildDecisionReason(input.decision),
    decidedAt,
  });
  if (!updated) {
    throw new Error('Approval request could not be updated.');
  }

  if (input.decision === 'approve_always') {
    input.repo.upsertApprovalRule(
      input.scope,
      updated.actionType,
      updated.fingerprint,
      'approve_always',
    );
  }

  input.repo.updateRun(input.scope, updated.runId, {
    status: input.decision === 'deny' ? 'REFINING' : 'EXECUTING',
    pausedForApproval: false,
    pendingApprovalActionType: null,
    lastError: input.decision === 'deny' ? `Action denied: ${updated.actionType}` : null,
  });
  input.repo.appendAuditEvent(input.scope, {
    category: 'approval',
    action: 'decision_applied',
    metadata: JSON.stringify({
      requestId: updated.id,
      runId: updated.runId,
      actionType: updated.actionType,
      decision: input.decision,
    }),
  });
  publishMasterUpdated({
    scope: input.scope,
    resources: ['approvals', 'runs', 'metrics', 'run_detail'],
    runId: updated.runId,
    approvalRequestId: updated.id,
  });

  return updated;
}

export function consumeApprovedApprovalRequest(input: {
  repo: MasterRepository;
  scope: WorkspaceScope;
  actionType: string;
  fingerprint: string;
}): MasterApprovalRequest | null {
  const request = input.repo
    .listApprovalRequests(input.scope)
    .find(
      (candidate) =>
        candidate.status === 'approved' &&
        candidate.decision === 'approve_once' &&
        candidate.actionType === input.actionType &&
        candidate.fingerprint === input.fingerprint,
    );
  if (!request) {
    return null;
  }

  const consumed = input.repo.updateApprovalRequest(input.scope, request.id, {
    status: 'expired',
    decisionReason: request.decisionReason ?? 'approve_once consumed by runtime',
  });
  if (consumed) {
    publishMasterUpdated({
      scope: input.scope,
      resources: ['approvals', 'runs', 'metrics', 'run_detail'],
      runId: consumed.runId,
      approvalRequestId: consumed.id,
    });
  }
  return consumed;
}
