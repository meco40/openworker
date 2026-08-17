import type { ApprovalDecision } from '@/shared/masterTypes';

export {
  type ApprovalDecision,
  type MasterRunStatus,
  type MasterRun,
  type MasterStep,
  type MasterFeedback,
  type MasterNote,
  type MasterReminder,
  type MasterApprovalRequest,
  type MasterToolPolicy,
  type MasterSubagentSession,
} from '@/shared/masterTypes';

export interface MasterActionLedgerEntry {
  id: string;
  runId: string;
  userId: string;
  workspaceId: string;
  stepId: string;
  actionType: string;
  idempotencyKey: string;
  state: 'planned' | 'started' | 'committed' | 'rolled_back' | 'failed';
  resultPayload: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MasterApprovalRule {
  id: string;
  userId: string;
  workspaceId: string;
  actionType: string;
  fingerprint: string;
  decision: ApprovalDecision;
  createdAt: string;
  updatedAt: string;
}

export interface MasterCapabilityScore {
  id: string;
  userId: string;
  workspaceId: string;
  capability: string;
  confidence: number;
  lastVerifiedAt: string | null;
  benchmarkSummary: string;
  updatedAt: string;
}

export interface MasterCapabilityProposal {
  id: string;
  userId: string;
  workspaceId: string;
  title: string;
  capabilityKey: string;
  status: 'draft' | 'awaiting_approval' | 'approved' | 'denied';
  proposal: string;
  fallbackPlan: string;
  createdAt: string;
  updatedAt: string;
}

export interface MasterToolForgeArtifact {
  id: string;
  userId: string;
  workspaceId: string;
  name: string;
  spec: string;
  manifest: string;
  testSummary: string;
  riskReport: string;
  status: 'draft' | 'awaiting_approval' | 'approved' | 'denied' | 'published';
  publishedGlobally: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface MasterConnectorSecret {
  id: string;
  userId: string;
  workspaceId: string;
  provider: string;
  keyRef: string;
  encryptedPayload: string;
  issuedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MasterAuditEvent {
  id: string;
  userId: string;
  workspaceId: string;
  category: string;
  action: string;
  metadata: string;
  createdAt: string;
}

export interface MasterRunCreateInput {
  userId: string;
  workspaceId: string;
  title: string;
  contract: string;
}

export interface WorkspaceScope {
  userId: string;
  workspaceId: string;
}

export interface TriggerPolicyDecision {
  allowed: boolean;
  reason?: 'cooldown_active' | 'capacity_exhausted' | 'budget_exceeded' | 'blocked';
}

export interface MasterDelegationJob {
  id: string;
  runId: string;
  userId: string;
  workspaceId: string;
  capability: string;
  payload: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  priority: 'low' | 'medium' | 'high';
  attempts: number;
  maxAttempts: number;
  timeoutMs: number;
  createdAt: string;
  updatedAt: string;
  lastError: string | null;
}

export interface MasterDelegationEvent {
  id: string;
  jobId: string;
  runId: string;
  userId: string;
  workspaceId: string;
  type: 'created' | 'started' | 'progress' | 'result' | 'error' | 'policy_denied' | 'cancelled';
  payload: string;
  createdAt: string;
}
