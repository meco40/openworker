import { afterEach, describe, expect, it } from 'vitest';
import { cleanupDb, createRepo, createScope } from './master-repository.harness';

describe('SqliteMasterRepository domain features', () => {
  const createdDbPaths: string[] = [];

  afterEach(() => {
    for (const dbPath of createdDbPaths.splice(0, createdDbPaths.length)) {
      cleanupDb(dbPath);
    }
  });

  it('supports notes/reminders/delegation/ledger/capabilities/toolforge/secrets', () => {
    const { repo, dbPath } = createRepo();
    createdDbPaths.push(dbPath);
    const scope = createScope('user-b', 'ws-main');

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
