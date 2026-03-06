import type { MasterRepository } from '@/server/master/repository';
import type { WorkspaceScope } from '@/server/master/types';
import { consumeApprovedApprovalRequest } from '@/server/master/approvals/service';
import { isMasterApprovalControlPlaneEnabled } from '@/server/master/featureFlags';
import { resolveToolPolicy } from '@/server/master/toolPolicy/service';

export type ApprovalGateDecision = 'allowed' | 'awaiting_approval' | 'denied';

export interface RuntimeApprovalResolution {
  decision: ApprovalGateDecision;
  actionType: string;
  fingerprint: string;
  reason?: string;
}

export function registerOneTimeApproval(
  _scope: WorkspaceScope,
  _actionType: string,
  _fingerprint: string,
): void {
  throw new Error(
    'registerOneTimeApproval is no longer supported; persist an approval request instead.',
  );
}

export function clearOneTimeApprovalsForTests(): void {
  // no-op; one-time approvals are now persisted in repository-backed approval requests
}

export function resolveRuntimeApproval(input: {
  repo: MasterRepository;
  scope: WorkspaceScope;
  actionType: string;
  fingerprint?: string;
  requiresApproval: boolean;
  toolName?: string;
  host?: 'sandbox' | 'gateway' | null;
  targetContext?: string | null;
}): RuntimeApprovalResolution {
  const actionType = String(input.actionType || '').trim();
  const fingerprint = String(input.fingerprint || actionType).trim() || actionType;
  const toolPolicy = resolveToolPolicy({
    repo: input.repo,
    scope: input.scope,
    actionType,
    toolName: input.toolName,
    host: input.host,
    targetContext: input.targetContext,
    fingerprint,
  });
  if (toolPolicy.decision === 'deny') {
    return {
      decision: 'denied',
      actionType,
      fingerprint,
      reason: toolPolicy.reason ?? `Action denied by tool policy: ${actionType}`,
    };
  }

  const requiresApproval = input.requiresApproval || toolPolicy.decision === 'ask';
  if (!requiresApproval) {
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

  const consumed = consumeApprovedApprovalRequest({
    repo: input.repo,
    scope: input.scope,
    actionType,
    fingerprint,
  });
  if (consumed) {
    return { decision: 'allowed', actionType, fingerprint };
  }

  if (!isMasterApprovalControlPlaneEnabled()) {
    return {
      decision: 'denied',
      actionType,
      fingerprint,
      reason: `Approval control plane is disabled for ${actionType}.`,
    };
  }

  return {
    decision: 'awaiting_approval',
    actionType,
    fingerprint,
    reason: toolPolicy.reason ?? `Approval required for ${actionType} (${fingerprint}).`,
  };
}
