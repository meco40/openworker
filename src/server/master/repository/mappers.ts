import type {
  MasterActionLedgerEntry,
  MasterAuditEvent,
  MasterCapabilityProposal,
  MasterCapabilityScore,
  MasterConnectorSecret,
  MasterDelegationEvent,
  MasterDelegationJob,
  MasterFeedback,
  MasterNote,
  MasterReminder,
  MasterRun,
  MasterStep,
  MasterToolForgeArtifact,
  WorkspaceScope,
} from '@/server/master/types';
import { parseJsonArray, toBool } from '@/server/master/repository/helpers';

export function toRun(row: Record<string, unknown>): MasterRun {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    workspaceId: String(row.workspace_id),
    title: String(row.title),
    contract: String(row.contract),
    status: row.status as MasterRun['status'],
    progress: Number(row.progress ?? 0),
    verificationPassed: toBool(row.verification_passed),
    resultBundle: row.result_bundle ? String(row.result_bundle) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    lastError: row.last_error ? String(row.last_error) : null,
    pausedForApproval: toBool(row.paused_for_approval),
    pendingApprovalActionType: row.pending_approval_action_type
      ? String(row.pending_approval_action_type)
      : null,
    cancelledAt: row.cancelled_at ? String(row.cancelled_at) : null,
    cancelReason: row.cancel_reason ? String(row.cancel_reason) : null,
  };
}

export function toStep(row: Record<string, unknown>): MasterStep {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    userId: String(row.user_id),
    workspaceId: String(row.workspace_id),
    seq: Number(row.seq),
    phase: String(row.phase),
    status: row.status as MasterStep['status'],
    input: row.input ? String(row.input) : null,
    output: row.output ? String(row.output) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function toFeedback(row: Record<string, unknown>): MasterFeedback {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    userId: String(row.user_id),
    workspaceId: String(row.workspace_id),
    rating: Number(row.rating),
    policy: row.policy as MasterFeedback['policy'],
    comment: row.comment ? String(row.comment) : null,
    createdAt: String(row.created_at),
  };
}

export function toNote(row: Record<string, unknown>): MasterNote {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    workspaceId: String(row.workspace_id),
    title: String(row.title),
    content: String(row.content),
    tags: parseJsonArray(row.tags),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function toReminder(row: Record<string, unknown>): MasterReminder {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    workspaceId: String(row.workspace_id),
    title: String(row.title),
    message: String(row.message),
    remindAt: String(row.remind_at),
    cronExpression: row.cron_expression ? String(row.cron_expression) : null,
    status: row.status as MasterReminder['status'],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function toDelegationJob(row: Record<string, unknown>): MasterDelegationJob {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    userId: String(row.user_id),
    workspaceId: String(row.workspace_id),
    capability: String(row.capability),
    payload: String(row.payload),
    status: row.status as MasterDelegationJob['status'],
    priority: row.priority as MasterDelegationJob['priority'],
    attempts: Number(row.attempts ?? 0),
    maxAttempts: Number(row.max_attempts ?? 3),
    timeoutMs: Number(row.timeout_ms ?? 120000),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    lastError: row.last_error ? String(row.last_error) : null,
  };
}

export function toDelegationEvent(row: Record<string, unknown>): MasterDelegationEvent {
  return {
    id: String(row.id),
    jobId: String(row.job_id),
    runId: String(row.run_id),
    userId: String(row.user_id),
    workspaceId: String(row.workspace_id),
    type: row.type as MasterDelegationEvent['type'],
    payload: String(row.payload),
    createdAt: String(row.created_at),
  };
}

export function toActionLedgerEntry(row: Record<string, unknown>): MasterActionLedgerEntry {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    userId: String(row.user_id),
    workspaceId: String(row.workspace_id),
    stepId: String(row.step_id),
    actionType: String(row.action_type),
    idempotencyKey: String(row.idempotency_key),
    state: row.state as MasterActionLedgerEntry['state'],
    resultPayload: row.result_payload ? String(row.result_payload) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function toCapabilityScore(row: Record<string, unknown>): MasterCapabilityScore {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    workspaceId: String(row.workspace_id),
    capability: String(row.capability),
    confidence: Number(row.confidence),
    lastVerifiedAt: row.last_verified_at ? String(row.last_verified_at) : null,
    benchmarkSummary: String(row.benchmark_summary || '{}'),
    updatedAt: String(row.updated_at),
  };
}

export function toCapabilityProposal(row: Record<string, unknown>): MasterCapabilityProposal {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    workspaceId: String(row.workspace_id),
    title: String(row.title),
    capabilityKey: String(row.capability_key),
    status: row.status as MasterCapabilityProposal['status'],
    proposal: String(row.proposal),
    fallbackPlan: String(row.fallback_plan),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function toToolForgeArtifact(row: Record<string, unknown>): MasterToolForgeArtifact {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    workspaceId: String(row.workspace_id),
    name: String(row.name),
    spec: String(row.spec),
    manifest: String(row.manifest),
    testSummary: String(row.test_summary),
    riskReport: String(row.risk_report),
    status: row.status as MasterToolForgeArtifact['status'],
    publishedGlobally: toBool(row.published_globally),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function toConnectorSecret(row: Record<string, unknown>): MasterConnectorSecret {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    workspaceId: String(row.workspace_id),
    provider: String(row.provider),
    keyRef: String(row.key_ref),
    encryptedPayload: String(row.encrypted_payload),
    issuedAt: row.issued_at ? String(row.issued_at) : null,
    expiresAt: row.expires_at ? String(row.expires_at) : null,
    revokedAt: row.revoked_at ? String(row.revoked_at) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function toAuditEvent(row: Record<string, unknown>): MasterAuditEvent {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    workspaceId: String(row.workspace_id),
    category: String(row.category),
    action: String(row.action),
    metadata: String(row.metadata || '{}'),
    createdAt: String(row.created_at),
  };
}

export function toWorkspaceScope(row: { user_id: string; workspace_id: string }): WorkspaceScope {
  return {
    userId: String(row.user_id),
    workspaceId: String(row.workspace_id),
  };
}
