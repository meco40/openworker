import type { MasterRepository } from '@/server/master/repository';
import type { WorkspaceScope } from '@/server/master/types';

export type ApprovalGateDecision = 'allowed' | 'awaiting_approval' | 'denied';

export interface RuntimeApprovalResolution {
  decision: ApprovalGateDecision;
  actionType: string;
  fingerprint: string;
  reason?: string;
}

const oneTimeApprovals = new Set<string>();

function approvalKey(scope: WorkspaceScope, actionType: string, fingerprint: string): string {
  return `${scope.userId}::${scope.workspaceId}::${actionType}::${fingerprint}`;
}

export function registerOneTimeApproval(
  scope: WorkspaceScope,
  actionType: string,
  fingerprint: string,
): void {
  oneTimeApprovals.add(approvalKey(scope, actionType, fingerprint));
}

export function clearOneTimeApprovalsForTests(): void {
  oneTimeApprovals.clear();
}

export function resolveRuntimeApproval(input: {
  repo: MasterRepository;
  scope: WorkspaceScope;
  actionType: string;
  fingerprint?: string;
  requiresApproval: boolean;
}): RuntimeApprovalResolution {
  const actionType = String(input.actionType || '').trim();
  const fingerprint = String(input.fingerprint || actionType).trim() || actionType;
  const key = approvalKey(input.scope, actionType, fingerprint);

  if (!input.requiresApproval) {
    return { decision: 'allowed', actionType, fingerprint };
  }

  if (oneTimeApprovals.has(key)) {
    oneTimeApprovals.delete(key);
    return { decision: 'allowed', actionType, fingerprint };
  }

  const rule = input.repo.getApprovalRule(input.scope, actionType, fingerprint);
  if (rule === 'deny') {
    return {
      decision: 'denied',
      actionType,
      fingerprint,
      reason: `Action denied by policy: ${actionType}`,
    };
  }
  if (rule === 'approve_always') {
    return { decision: 'allowed', actionType, fingerprint };
  }

  return {
    decision: 'awaiting_approval',
    actionType,
    fingerprint,
    reason: `Approval required for ${actionType} (${fingerprint}).`,
  };
}
