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

    const leasedRun = repo.updateRun(scope, run.id, {
      ownerId: 'worker-a',
      leaseExpiresAt: '2026-03-06T12:00:00.000Z',
      heartbeatAt: '2026-03-06T11:59:00.000Z',
    });
    expect(leasedRun?.ownerId).toBe('worker-a');
    expect(leasedRun?.leaseExpiresAt).toBe('2026-03-06T12:00:00.000Z');
    expect(leasedRun?.heartbeatAt).toBe('2026-03-06T11:59:00.000Z');

    const approvalRequest = repo.createApprovalRequest(scope, {
      runId: run.id,
      stepId: 'step-approve-1',
      toolName: 'shell_execute',
      actionType: 'shell.exec',
      summary: 'Run npm test in workspace',
      prompt: 'Allow the shell command for this run?',
      host: 'gateway',
      cwd: 'D:/web/clawtest',
      resolvedPath: 'D:/web/clawtest',
      fingerprint: 'shell_execute:gateway:D:/web/clawtest:npm test',
      riskLevel: 'high',
      status: 'pending',
      expiresAt: '2026-03-06T12:05:00.000Z',
      decision: null,
      decisionReason: null,
      decidedAt: null,
    });
    expect(repo.listApprovalRequests(scope, run.id)).toHaveLength(1);
    const approvedRequest = repo.updateApprovalRequest(scope, approvalRequest.id, {
      status: 'approved',
      decision: 'approve_once',
      decidedAt: '2026-03-06T12:01:00.000Z',
    });
    expect(approvedRequest?.decision).toBe('approve_once');
    expect(approvedRequest?.status).toBe('approved');

    const toolPolicy = repo.upsertToolPolicy(scope, {
      security: 'allowlist',
      ask: 'on_miss',
      allowlist: ['shell_execute:gateway:D:/web/clawtest:*'],
      updatedBy: 'operator-user',
    });
    expect(toolPolicy.security).toBe('allowlist');
    expect(repo.getToolPolicy(scope)?.allowlist).toContain(
      'shell_execute:gateway:D:/web/clawtest:*',
    );

    const session = repo.createSubagentSession(scope, {
      runId: run.id,
      status: 'queued',
      title: 'Investigate failing command',
      prompt: 'Inspect the failing shell command and summarize root cause.',
      assignedTools: ['read', 'shell_execute'],
      ownerId: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      latestEventAt: null,
      resultSummary: null,
      lastError: null,
    });
    expect(repo.listSubagentSessions(scope, run.id)).toHaveLength(1);
    const runningSession = repo.updateSubagentSession(scope, session.id, {
      status: 'running',
      ownerId: 'worker-a',
      leaseExpiresAt: '2026-03-06T12:10:00.000Z',
      heartbeatAt: '2026-03-06T12:02:00.000Z',
    });
    expect(runningSession?.status).toBe('running');
    expect(runningSession?.ownerId).toBe('worker-a');

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
