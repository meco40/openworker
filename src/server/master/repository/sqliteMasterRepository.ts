import { createMasterSqliteDb, type MasterSqliteDb } from '@/server/master/repository/db';
import {
  addFeedback,
  appendStep,
  createRun,
  getRun,
  listRuns,
  listSteps,
  updateRun,
} from '@/server/master/repository/runs.store';
import {
  createNote,
  deleteNote,
  listNotes,
  updateNote,
} from '@/server/master/repository/notes.store';
import {
  createReminder,
  deleteReminder,
  listReminders,
  updateReminder,
} from '@/server/master/repository/reminders.store';
import {
  appendDelegationEvent,
  createDelegationJob,
  listDelegationEvents,
  listDelegationJobs,
  updateDelegationJob,
} from '@/server/master/repository/delegation.store';
import {
  createCapabilityProposal,
  getActionLedgerByKey,
  getApprovalRule,
  listCapabilityProposals,
  listCapabilityScores,
  upsertActionLedger,
  upsertApprovalRule,
  upsertCapabilityScore,
} from '@/server/master/repository/governance.store';
import {
  createToolForgeArtifact,
  listGlobalToolForgeArtifacts,
  listToolForgeArtifacts,
  updateToolForgeArtifact,
} from '@/server/master/repository/toolforge.store';
import {
  getConnectorSecret,
  upsertConnectorSecret,
} from '@/server/master/repository/secrets.store';
import { appendAuditEvent, listAuditEvents } from '@/server/master/repository/audit.store';
import {
  migrateUserLegacyScopesToMasterPersona,
  migrateWorkspaceScope,
} from '@/server/master/repository/migration.store';
import { listKnownScopes } from '@/server/master/repository/scopes.store';
import type { MasterRepository } from '@/server/master/repository';
import type {
  ApprovalDecision,
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
  MasterRunCreateInput,
  MasterStep,
  MasterToolForgeArtifact,
  WorkspaceScope,
} from '@/server/master/types';

export class SqliteMasterRepository implements MasterRepository {
  private readonly db: MasterSqliteDb;

  constructor(dbPath = process.env.MASTER_DB_PATH || '.local/master.db') {
    this.db = createMasterSqliteDb(dbPath);
  }

  createRun(input: MasterRunCreateInput): MasterRun {
    return createRun(this.db, input);
  }

  getRun(scope: WorkspaceScope, runId: string): MasterRun | null {
    return getRun(this.db, scope, runId);
  }

  listRuns(scope: WorkspaceScope, limit = 50): MasterRun[] {
    return listRuns(this.db, scope, limit);
  }

  updateRun(scope: WorkspaceScope, runId: string, patch: Partial<MasterRun>): MasterRun | null {
    return updateRun(this.db, scope, runId, patch);
  }

  appendStep(
    scope: WorkspaceScope,
    runId: string,
    step: Omit<MasterStep, 'id' | 'createdAt' | 'updatedAt'>,
  ): MasterStep {
    return appendStep(this.db, scope, runId, step);
  }

  listSteps(scope: WorkspaceScope, runId: string): MasterStep[] {
    return listSteps(this.db, scope, runId);
  }

  addFeedback(
    scope: WorkspaceScope,
    feedback: Omit<MasterFeedback, 'id' | 'createdAt'>,
  ): MasterFeedback {
    return addFeedback(this.db, scope, feedback);
  }

  createNote(
    scope: WorkspaceScope,
    input: Omit<MasterNote, 'id' | 'userId' | 'workspaceId' | 'createdAt' | 'updatedAt'>,
  ): MasterNote {
    return createNote(this.db, scope, input);
  }

  listNotes(scope: WorkspaceScope, limit = 100): MasterNote[] {
    return listNotes(this.db, scope, limit);
  }

  updateNote(
    scope: WorkspaceScope,
    noteId: string,
    patch: Partial<Pick<MasterNote, 'title' | 'content' | 'tags'>>,
  ): MasterNote | null {
    return updateNote(this.db, scope, noteId, patch);
  }

  deleteNote(scope: WorkspaceScope, noteId: string): boolean {
    return deleteNote(this.db, scope, noteId);
  }

  createReminder(
    scope: WorkspaceScope,
    input: Omit<MasterReminder, 'id' | 'userId' | 'workspaceId' | 'createdAt' | 'updatedAt'>,
  ): MasterReminder {
    return createReminder(this.db, scope, input);
  }

  listReminders(scope: WorkspaceScope, limit = 100): MasterReminder[] {
    return listReminders(this.db, scope, limit);
  }

  updateReminder(
    scope: WorkspaceScope,
    reminderId: string,
    patch: Partial<MasterReminder>,
  ): MasterReminder | null {
    return updateReminder(this.db, scope, reminderId, patch);
  }

  deleteReminder(scope: WorkspaceScope, reminderId: string): boolean {
    return deleteReminder(this.db, scope, reminderId);
  }

  createDelegationJob(
    scope: WorkspaceScope,
    job: Omit<
      MasterDelegationJob,
      'id' | 'userId' | 'workspaceId' | 'createdAt' | 'updatedAt' | 'attempts' | 'lastError'
    >,
  ): MasterDelegationJob {
    return createDelegationJob(this.db, scope, job);
  }

  updateDelegationJob(
    scope: WorkspaceScope,
    jobId: string,
    patch: Partial<MasterDelegationJob>,
  ): MasterDelegationJob | null {
    return updateDelegationJob(this.db, scope, jobId, patch);
  }

  listDelegationJobs(scope: WorkspaceScope, runId: string): MasterDelegationJob[] {
    return listDelegationJobs(this.db, scope, runId);
  }

  appendDelegationEvent(
    scope: WorkspaceScope,
    event: Omit<MasterDelegationEvent, 'id' | 'userId' | 'workspaceId' | 'createdAt'>,
  ): MasterDelegationEvent {
    return appendDelegationEvent(this.db, scope, event);
  }

  listDelegationEvents(scope: WorkspaceScope, runId: string): MasterDelegationEvent[] {
    return listDelegationEvents(this.db, scope, runId);
  }

  upsertActionLedger(
    scope: WorkspaceScope,
    entry: Omit<
      MasterActionLedgerEntry,
      'id' | 'userId' | 'workspaceId' | 'createdAt' | 'updatedAt'
    >,
  ): MasterActionLedgerEntry {
    return upsertActionLedger(this.db, scope, entry);
  }

  getActionLedgerByKey(
    scope: WorkspaceScope,
    idempotencyKey: string,
  ): MasterActionLedgerEntry | null {
    return getActionLedgerByKey(this.db, scope, idempotencyKey);
  }

  upsertApprovalRule(
    scope: WorkspaceScope,
    actionType: string,
    fingerprint: string,
    decision: ApprovalDecision,
  ): void {
    upsertApprovalRule(this.db, scope, actionType, fingerprint, decision);
  }

  getApprovalRule(
    scope: WorkspaceScope,
    actionType: string,
    fingerprint: string,
  ): ApprovalDecision | null {
    return getApprovalRule(this.db, scope, actionType, fingerprint);
  }

  upsertCapabilityScore(
    scope: WorkspaceScope,
    capability: string,
    confidence: number,
    benchmarkSummary: string,
    lastVerifiedAt: string | null,
  ): MasterCapabilityScore {
    return upsertCapabilityScore(
      this.db,
      scope,
      capability,
      confidence,
      benchmarkSummary,
      lastVerifiedAt,
    );
  }

  listCapabilityScores(scope: WorkspaceScope): MasterCapabilityScore[] {
    return listCapabilityScores(this.db, scope);
  }

  createCapabilityProposal(
    scope: WorkspaceScope,
    proposal: Omit<
      MasterCapabilityProposal,
      'id' | 'userId' | 'workspaceId' | 'createdAt' | 'updatedAt'
    >,
  ): MasterCapabilityProposal {
    return createCapabilityProposal(this.db, scope, proposal);
  }

  listCapabilityProposals(scope: WorkspaceScope): MasterCapabilityProposal[] {
    return listCapabilityProposals(this.db, scope);
  }

  createToolForgeArtifact(
    scope: WorkspaceScope,
    artifact: Omit<
      MasterToolForgeArtifact,
      'id' | 'userId' | 'workspaceId' | 'createdAt' | 'updatedAt'
    >,
  ): MasterToolForgeArtifact {
    return createToolForgeArtifact(this.db, scope, artifact);
  }

  updateToolForgeArtifact(
    scope: WorkspaceScope,
    artifactId: string,
    patch: Partial<MasterToolForgeArtifact>,
  ): MasterToolForgeArtifact | null {
    return updateToolForgeArtifact(this.db, scope, artifactId, patch);
  }

  listToolForgeArtifacts(scope: WorkspaceScope): MasterToolForgeArtifact[] {
    return listToolForgeArtifacts(this.db, scope);
  }

  listGlobalToolForgeArtifacts(limit = 200): MasterToolForgeArtifact[] {
    return listGlobalToolForgeArtifacts(this.db, limit);
  }

  upsertConnectorSecret(
    scope: WorkspaceScope,
    secret: Omit<
      MasterConnectorSecret,
      'id' | 'userId' | 'workspaceId' | 'createdAt' | 'updatedAt'
    >,
  ): MasterConnectorSecret {
    return upsertConnectorSecret(this.db, scope, secret);
  }

  getConnectorSecret(
    scope: WorkspaceScope,
    provider: string,
    keyRef: string,
  ): MasterConnectorSecret | null {
    return getConnectorSecret(this.db, scope, provider, keyRef);
  }

  appendAuditEvent(
    scope: WorkspaceScope,
    input: Omit<MasterAuditEvent, 'id' | 'userId' | 'workspaceId' | 'createdAt'>,
  ): MasterAuditEvent {
    return appendAuditEvent(this.db, scope, input);
  }

  listAuditEvents(scope: WorkspaceScope, limit = 200): MasterAuditEvent[] {
    return listAuditEvents(this.db, scope, limit);
  }

  listKnownScopes(limit = 500): WorkspaceScope[] {
    return listKnownScopes(this.db, limit);
  }

  migrateWorkspaceScope(userId: string, fromWorkspaceId: string, toWorkspaceId: string): void {
    migrateWorkspaceScope(this.db, { userId, fromWorkspaceId, toWorkspaceId });
  }

  migrateUserLegacyScopesToMasterPersona(userId: string, masterPersonaId: string): number {
    return migrateUserLegacyScopesToMasterPersona(this.db, userId, masterPersonaId);
  }

  close(): void {
    this.db.close();
  }
}
