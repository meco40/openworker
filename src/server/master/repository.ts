import type {
  ApprovalDecision,
  MasterActionLedgerEntry,
  MasterCapabilityProposal,
  MasterCapabilityScore,
  MasterConnectorSecret,
  MasterDelegationEvent,
  MasterDelegationJob,
  MasterAuditEvent,
  MasterFeedback,
  MasterNote,
  MasterReminder,
  MasterRun,
  MasterRunCreateInput,
  MasterStep,
  MasterToolForgeArtifact,
  WorkspaceScope,
} from '@/server/master/types';

export interface MasterRepository {
  createRun(input: MasterRunCreateInput): MasterRun;
  getRun(scope: WorkspaceScope, runId: string): MasterRun | null;
  listRuns(scope: WorkspaceScope, limit?: number): MasterRun[];
  updateRun(scope: WorkspaceScope, runId: string, patch: Partial<MasterRun>): MasterRun | null;

  appendStep(
    scope: WorkspaceScope,
    runId: string,
    step: Omit<MasterStep, 'id' | 'createdAt' | 'updatedAt'>,
  ): MasterStep;
  listSteps(scope: WorkspaceScope, runId: string): MasterStep[];

  addFeedback(
    scope: WorkspaceScope,
    feedback: Omit<MasterFeedback, 'id' | 'createdAt'>,
  ): MasterFeedback;

  createNote(
    scope: WorkspaceScope,
    input: Omit<MasterNote, 'id' | 'userId' | 'workspaceId' | 'createdAt' | 'updatedAt'>,
  ): MasterNote;
  listNotes(scope: WorkspaceScope, limit?: number): MasterNote[];
  updateNote(
    scope: WorkspaceScope,
    noteId: string,
    patch: Partial<Pick<MasterNote, 'title' | 'content' | 'tags'>>,
  ): MasterNote | null;
  deleteNote(scope: WorkspaceScope, noteId: string): boolean;

  createReminder(
    scope: WorkspaceScope,
    input: Omit<MasterReminder, 'id' | 'userId' | 'workspaceId' | 'createdAt' | 'updatedAt'>,
  ): MasterReminder;
  listReminders(scope: WorkspaceScope, limit?: number): MasterReminder[];
  updateReminder(
    scope: WorkspaceScope,
    reminderId: string,
    patch: Partial<MasterReminder>,
  ): MasterReminder | null;
  deleteReminder(scope: WorkspaceScope, reminderId: string): boolean;

  createDelegationJob(
    scope: WorkspaceScope,
    job: Omit<
      MasterDelegationJob,
      'id' | 'userId' | 'workspaceId' | 'createdAt' | 'updatedAt' | 'attempts' | 'lastError'
    >,
  ): MasterDelegationJob;
  updateDelegationJob(
    scope: WorkspaceScope,
    jobId: string,
    patch: Partial<MasterDelegationJob>,
  ): MasterDelegationJob | null;
  listDelegationJobs(scope: WorkspaceScope, runId: string): MasterDelegationJob[];
  appendDelegationEvent(
    scope: WorkspaceScope,
    event: Omit<MasterDelegationEvent, 'id' | 'userId' | 'workspaceId' | 'createdAt'>,
  ): MasterDelegationEvent;
  listDelegationEvents(scope: WorkspaceScope, runId: string): MasterDelegationEvent[];

  upsertActionLedger(
    scope: WorkspaceScope,
    entry: Omit<
      MasterActionLedgerEntry,
      'id' | 'userId' | 'workspaceId' | 'createdAt' | 'updatedAt'
    >,
  ): MasterActionLedgerEntry;
  getActionLedgerByKey(
    scope: WorkspaceScope,
    idempotencyKey: string,
  ): MasterActionLedgerEntry | null;

  upsertApprovalRule(
    scope: WorkspaceScope,
    actionType: string,
    fingerprint: string,
    decision: ApprovalDecision,
  ): void;
  getApprovalRule(
    scope: WorkspaceScope,
    actionType: string,
    fingerprint: string,
  ): ApprovalDecision | null;

  upsertCapabilityScore(
    scope: WorkspaceScope,
    capability: string,
    confidence: number,
    benchmarkSummary: string,
    lastVerifiedAt: string | null,
  ): MasterCapabilityScore;
  listCapabilityScores(scope: WorkspaceScope): MasterCapabilityScore[];

  createCapabilityProposal(
    scope: WorkspaceScope,
    proposal: Omit<
      MasterCapabilityProposal,
      'id' | 'userId' | 'workspaceId' | 'createdAt' | 'updatedAt'
    >,
  ): MasterCapabilityProposal;
  listCapabilityProposals(scope: WorkspaceScope): MasterCapabilityProposal[];

  createToolForgeArtifact(
    scope: WorkspaceScope,
    artifact: Omit<
      MasterToolForgeArtifact,
      'id' | 'userId' | 'workspaceId' | 'createdAt' | 'updatedAt'
    >,
  ): MasterToolForgeArtifact;
  updateToolForgeArtifact(
    scope: WorkspaceScope,
    artifactId: string,
    patch: Partial<MasterToolForgeArtifact>,
  ): MasterToolForgeArtifact | null;
  listToolForgeArtifacts(scope: WorkspaceScope): MasterToolForgeArtifact[];
  listGlobalToolForgeArtifacts(limit?: number): MasterToolForgeArtifact[];

  upsertConnectorSecret(
    scope: WorkspaceScope,
    secret: Omit<
      MasterConnectorSecret,
      'id' | 'userId' | 'workspaceId' | 'createdAt' | 'updatedAt'
    >,
  ): MasterConnectorSecret;
  getConnectorSecret(
    scope: WorkspaceScope,
    provider: string,
    keyRef: string,
  ): MasterConnectorSecret | null;

  appendAuditEvent(
    scope: WorkspaceScope,
    input: Omit<MasterAuditEvent, 'id' | 'userId' | 'workspaceId' | 'createdAt'>,
  ): MasterAuditEvent;
  listAuditEvents(scope: WorkspaceScope, limit?: number): MasterAuditEvent[];

  listKnownScopes(limit?: number): WorkspaceScope[];

  close(): void;
}
