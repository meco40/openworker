import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteMasterRepository } from '@/server/master/sqliteMasterRepository';
import type { WorkspaceScope } from '@/server/master/types';
import { getTestArtifactsRoot } from '../../helpers/testArtifacts';

function uniqueDbPath(): string {
  return path.join(
    getTestArtifactsRoot(),
    `master.repo.${Date.now()}.${Math.random().toString(36).slice(2)}.db`,
  );
}

describe('SqliteMasterRepository', () => {
  const createdDbPaths: string[] = [];

  afterEach(() => {
    for (const dbPath of createdDbPaths.splice(0, createdDbPaths.length)) {
      if (fs.existsSync(dbPath)) {
        try {
          fs.unlinkSync(dbPath);
        } catch {
          // ignore on transient locks
        }
      }
    }
  });

  it('persists runs, steps, feedback, and scoped updates', () => {
    const dbPath = uniqueDbPath();
    createdDbPaths.push(dbPath);
    const repo = new SqliteMasterRepository(dbPath);
    const scope: WorkspaceScope = { userId: 'user-a', workspaceId: 'ws-1' };
    const foreign: WorkspaceScope = { userId: 'user-a', workspaceId: 'ws-2' };

    const run = repo.createRun({
      userId: scope.userId,
      workspaceId: scope.workspaceId,
      title: 'Build report',
      contract: 'deliver final report',
    });
    expect(run.status).toBe('ANALYZING');

    const updated = repo.updateRun(scope, run.id, {
      status: 'AWAITING_APPROVAL',
      pausedForApproval: true,
      progress: 42,
    });
    expect(updated?.pausedForApproval).toBe(true);
    expect(updated?.progress).toBe(42);
    expect(repo.getRun(foreign, run.id)).toBeNull();

    const step = repo.appendStep(scope, run.id, {
      runId: run.id,
      userId: scope.userId,
      workspaceId: scope.workspaceId,
      seq: 1,
      phase: 'planning',
      status: 'running',
      input: 'brief',
      output: null,
    });
    expect(step.seq).toBe(1);
    expect(repo.listSteps(scope, run.id)).toHaveLength(1);

    const feedback = repo.addFeedback(scope, {
      runId: run.id,
      userId: scope.userId,
      workspaceId: scope.workspaceId,
      rating: 5,
      policy: 'balanced',
      comment: 'ok',
    });
    expect(feedback.rating).toBe(5);

    repo.close();
  });

  it('supports notes/reminders/delegation/ledger/capabilities/toolforge/secrets', () => {
    const dbPath = uniqueDbPath();
    createdDbPaths.push(dbPath);
    const repo = new SqliteMasterRepository(dbPath);
    const scope: WorkspaceScope = { userId: 'user-b', workspaceId: 'ws-main' };

    const run = repo.createRun({
      userId: scope.userId,
      workspaceId: scope.workspaceId,
      title: 'Ops task',
      contract: 'handle approvals',
    });

    const note = repo.createNote(scope, {
      title: 'todo',
      content: 'first note',
      tags: ['master'],
    });
    expect(repo.listNotes(scope)).toHaveLength(1);
    const updatedNote = repo.updateNote(scope, note.id, { title: 'todo-2' });
    expect(updatedNote?.title).toBe('todo-2');
    expect(repo.deleteNote(scope, note.id)).toBe(true);

    const reminder = repo.createReminder(scope, {
      title: 'daily',
      message: 'review',
      remindAt: new Date().toISOString(),
      cronExpression: '0 3 * * *',
      status: 'pending',
    });
    const updatedReminder = repo.updateReminder(scope, reminder.id, { status: 'paused' });
    expect(updatedReminder?.status).toBe('paused');
    expect(repo.deleteReminder(scope, reminder.id)).toBe(true);

    const job = repo.createDelegationJob(scope, {
      runId: run.id,
      capability: 'web_search',
      payload: '{"query":"x"}',
      status: 'queued',
      priority: 'medium',
      maxAttempts: 2,
      timeoutMs: 15_000,
    });
    expect(repo.listDelegationJobs(scope, run.id)).toHaveLength(1);
    const updatedJob = repo.updateDelegationJob(scope, job.id, { status: 'running' });
    expect(updatedJob?.status).toBe('running');
    repo.appendDelegationEvent(scope, {
      jobId: job.id,
      runId: run.id,
      type: 'started',
      payload: '{"ok":true}',
    });
    expect(repo.listDelegationEvents(scope, run.id)).toHaveLength(1);

    const ledger = repo.upsertActionLedger(scope, {
      runId: run.id,
      stepId: 'step-1',
      actionType: 'gmail.send',
      idempotencyKey: `${run.id}:step-1:gmail.send`,
      state: 'planned',
      resultPayload: null,
    });
    expect(ledger.state).toBe('planned');
    const ledger2 = repo.upsertActionLedger(scope, {
      runId: run.id,
      stepId: 'step-1',
      actionType: 'gmail.send',
      idempotencyKey: `${run.id}:step-1:gmail.send`,
      state: 'committed',
      resultPayload: '{"id":"msg-1"}',
    });
    expect(ledger2.state).toBe('committed');
    expect(repo.getActionLedgerByKey(scope, ledger.idempotencyKey)?.resultPayload).toContain(
      'msg-1',
    );

    repo.upsertApprovalRule(scope, 'gmail.send', 'fingerprint-1', 'approve_always');
    expect(repo.getApprovalRule(scope, 'gmail.send', 'fingerprint-1')).toBe('approve_always');

    repo.upsertCapabilityScore(scope, 'gmail', 0.8, '{"latencyMs":200}', new Date().toISOString());
    expect(repo.listCapabilityScores(scope)).toHaveLength(1);

    repo.createCapabilityProposal(scope, {
      title: 'Instagram connector proposal',
      capabilityKey: 'instagram',
      status: 'awaiting_approval',
      proposal: 'use official api',
      fallbackPlan: 'manual workflow',
    });
    expect(repo.listCapabilityProposals(scope)).toHaveLength(1);

    const artifact = repo.createToolForgeArtifact(scope, {
      name: 'mail_summary_tool',
      spec: '{}',
      manifest: '{}',
      testSummary: 'ok',
      riskReport: 'low',
      status: 'awaiting_approval',
      publishedGlobally: false,
    });
    const published = repo.updateToolForgeArtifact(scope, artifact.id, { publishedGlobally: true });
    expect(published?.publishedGlobally).toBe(true);

    repo.upsertConnectorSecret(scope, {
      provider: 'gmail',
      keyRef: 'default',
      encryptedPayload: 'enc:abc',
      issuedAt: new Date().toISOString(),
      expiresAt: null,
      revokedAt: null,
    });
    expect(repo.getConnectorSecret(scope, 'gmail', 'default')?.encryptedPayload).toBe('enc:abc');

    repo.close();
  });
});
