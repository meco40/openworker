export type MasterRunStatus =
  | 'IDLE'
  | 'ANALYZING'
  | 'PLANNING'
  | 'DELEGATING'
  | 'EXECUTING'
  | 'VERIFYING'
  | 'REFINING'
  | 'AWAITING_APPROVAL'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'FAILED';

export type ApprovalDecision = 'approve_once' | 'approve_always' | 'deny';

export interface MasterRun {
  id: string;
  userId: string;
  workspaceId: string;
  title: string;
  contract: string;
  status: MasterRunStatus;
  progress: number;
  verificationPassed: boolean;
  resultBundle: string | null;
  createdAt: string;
  updatedAt: string;
  lastError: string | null;
  pausedForApproval: boolean;
  pendingApprovalActionType: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  ownerId: string | null;
  leaseExpiresAt: string | null;
  heartbeatAt: string | null;
}

export interface MasterStep {
  id: string;
  runId: string;
  userId: string;
  workspaceId: string;
  seq: number;
  phase: string;
  status: 'pending' | 'running' | 'done' | 'error' | 'blocked';
  input: string | null;
  output: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MasterFeedback {
  id: string;
  runId: string;
  userId: string;
  workspaceId: string;
  rating: number;
  policy: 'safe' | 'balanced' | 'fast';
  comment: string | null;
  createdAt: string;
}

export interface MasterNote {
  id: string;
  userId: string;
  workspaceId: string;
  title: string;
  content: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface MasterReminder {
  id: string;
  userId: string;
  workspaceId: string;
  title: string;
  message: string;
  remindAt: string;
  cronExpression: string | null;
  status: 'pending' | 'fired' | 'paused' | 'cancelled';
  createdAt: string;
  updatedAt: string;
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

export interface MasterApprovalRequest {
  id: string;
  runId: string;
  stepId: string;
  userId: string;
  workspaceId: string;
  toolName: string;
  actionType: string;
  summary: string;
  prompt: string;
  host: 'sandbox' | 'gateway' | null;
  cwd: string | null;
  resolvedPath: string | null;
  fingerprint: string;
  riskLevel: 'low' | 'medium' | 'high';
  status: 'pending' | 'approved' | 'denied' | 'expired';
  expiresAt: string;
  decision: ApprovalDecision | null;
  decisionReason: string | null;
  decidedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MasterToolPolicy {
  id: string;
  userId: string;
  workspaceId: string;
  security: 'deny' | 'allowlist' | 'full';
  ask: 'off' | 'on_miss' | 'always';
  allowlist: string[];
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MasterSubagentSession {
  id: string;
  runId: string;
  userId: string;
  workspaceId: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  title: string;
  prompt: string;
  assignedTools: string[];
  ownerId: string | null;
  leaseExpiresAt: string | null;
  heartbeatAt: string | null;
  latestEventAt: string | null;
  resultSummary: string | null;
  lastError: string | null;
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
