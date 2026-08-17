import { afterEach, describe, expect, it } from 'vitest';
import { DelegationInbox } from '@/server/master/delegation/inbox';
import { SubagentPool } from '@/server/master/delegation/subagentPool';
import { createSubagentSessionForDispatch } from '@/server/master/delegation/sessionService';
import { cleanupDb, createRepo, createScope } from './repository/master-repository.harness';

describe('master subagent pool branches', () => {
  const createdDbPaths: string[] = [];

  afterEach(() => {
    for (const dbPath of createdDbPaths.splice(0, createdDbPaths.length)) {
      cleanupDb(dbPath);
    }
  });

  it('completes a session when the task succeeds', async () => {
    const { repo, dbPath } = createRepo();
    createdDbPaths.push(dbPath);
    const scope = createScope('user-pool-success', 'ws-pool-success');
    const run = repo.createRun({
      userId: scope.userId,
      workspaceId: scope.workspaceId,
      title: 'Success run',
      contract: 'success',
    });
    const session = createSubagentSessionForDispatch(repo, scope, {
      runId: run.id,
      capability: 'web_search',
      payload: '{"q":"test"}',
      assignedTools: ['web_search'],
    });
    const job = repo.createDelegationJob(scope, {
      runId: run.id,
      capability: 'web_search',
      payload: '{"q":"test"}',
      status: 'queued',
      priority: 'medium',
      maxAttempts: 3,
      timeoutMs: 60_000,
    });

    const pool = new SubagentPool(repo, new DelegationInbox(repo), {
      heartbeatIntervalMs: 5,
      leaseMs: 1000,
    });

    await pool.execute(scope, run.id, job.id, session.id, async () => ({
      output: 'success output',
      confidence: 0.9,
    }));

    const updatedJob = repo.listDelegationJobs(scope, run.id).find((j) => j.id === job.id);
    expect(updatedJob?.status).toBe('completed');

    const updatedSession = repo.getSubagentSession(scope, session.id);
    expect(updatedSession?.status).toBe('completed');
    expect(updatedSession?.resultSummary).toBe('success output');

    repo.close();
  });

  it('completes without a session when task succeeds', async () => {
    const { repo, dbPath } = createRepo();
    createdDbPaths.push(dbPath);
    const scope = createScope('user-pool-no-session', 'ws-pool-no-session');
    const run = repo.createRun({
      userId: scope.userId,
      workspaceId: scope.workspaceId,
      title: 'No session run',
      contract: 'no-session',
    });
    const job = repo.createDelegationJob(scope, {
      runId: run.id,
      capability: 'web_search',
      payload: '{"q":"test"}',
      status: 'queued',
      priority: 'medium',
      maxAttempts: 3,
      timeoutMs: 60_000,
    });

    const pool = new SubagentPool(repo, new DelegationInbox(repo));

    await pool.execute(scope, run.id, job.id, null, async () => ({
      output: 'no session output',
    }));

    const updatedJob = repo.listDelegationJobs(scope, run.id).find((j) => j.id === job.id);
    expect(updatedJob?.status).toBe('completed');

    repo.close();
  });

  it('fails the session when the task throws', async () => {
    const { repo, dbPath } = createRepo();
    createdDbPaths.push(dbPath);
    const scope = createScope('user-pool-fail', 'ws-pool-fail');
    const run = repo.createRun({
      userId: scope.userId,
      workspaceId: scope.workspaceId,
      title: 'Fail run',
      contract: 'fail',
    });
    const session = createSubagentSessionForDispatch(repo, scope, {
      runId: run.id,
      capability: 'web_search',
      payload: '{"q":"test"}',
      assignedTools: ['web_search'],
    });
    const job = repo.createDelegationJob(scope, {
      runId: run.id,
      capability: 'web_search',
      payload: '{"q":"test"}',
      status: 'queued',
      priority: 'medium',
      maxAttempts: 3,
      timeoutMs: 60_000,
    });

    const pool = new SubagentPool(repo, new DelegationInbox(repo));

    await expect(
      pool.execute(scope, run.id, job.id, session.id, async () => {
        throw new Error('task failed');
      }),
    ).rejects.toThrow('task failed');

    const updatedJob = repo.listDelegationJobs(scope, run.id).find((j) => j.id === job.id);
    expect(updatedJob?.status).toBe('failed');
    expect(updatedJob?.lastError).toBe('task failed');

    const updatedSession = repo.getSubagentSession(scope, session.id);
    expect(updatedSession?.status).toBe('failed');

    repo.close();
  });

  it('fails without a session when the task throws', async () => {
    const { repo, dbPath } = createRepo();
    createdDbPaths.push(dbPath);
    const scope = createScope('user-pool-fail-no-session', 'ws-pool-fail-no-session');
    const run = repo.createRun({
      userId: scope.userId,
      workspaceId: scope.workspaceId,
      title: 'Fail no session run',
      contract: 'fail-no-session',
    });
    const job = repo.createDelegationJob(scope, {
      runId: run.id,
      capability: 'web_search',
      payload: '{"q":"test"}',
      status: 'queued',
      priority: 'medium',
      maxAttempts: 3,
      timeoutMs: 60_000,
    });

    const pool = new SubagentPool(repo, new DelegationInbox(repo));

    await expect(
      pool.execute(scope, run.id, job.id, null, async () => {
        throw new Error('no session failure');
      }),
    ).rejects.toThrow('no session failure');

    const updatedJob = repo.listDelegationJobs(scope, run.id).find((j) => j.id === job.id);
    expect(updatedJob?.status).toBe('failed');
    expect(updatedJob?.lastError).toBe('no session failure');

    repo.close();
  });

  it('keeps a cancelled session cancelled when task succeeds', async () => {
    const { repo, dbPath } = createRepo();
    createdDbPaths.push(dbPath);
    const scope = createScope('user-pool-cancel-success', 'ws-pool-cancel-success');
    const run = repo.createRun({
      userId: scope.userId,
      workspaceId: scope.workspaceId,
      title: 'Cancel success run',
      contract: 'cancel-success',
    });
    const session = createSubagentSessionForDispatch(repo, scope, {
      runId: run.id,
      capability: 'web_search',
      payload: '{"q":"test"}',
      assignedTools: ['web_search'],
    });
    const job = repo.createDelegationJob(scope, {
      runId: run.id,
      capability: 'web_search',
      payload: '{"q":"test"}',
      status: 'queued',
      priority: 'medium',
      maxAttempts: 3,
      timeoutMs: 60_000,
    });

    // Cancel the session before execution
    repo.updateSubagentSession(scope, session.id, { status: 'cancelled' });

    const pool = new SubagentPool(repo, new DelegationInbox(repo));

    await pool.execute(scope, run.id, job.id, session.id, async () => ({
      output: 'should not complete',
    }));

    const updatedJob = repo.listDelegationJobs(scope, run.id).find((j) => j.id === job.id);
    expect(updatedJob?.status).toBe('cancelled');

    const updatedSession = repo.getSubagentSession(scope, session.id);
    expect(updatedSession?.status).toBe('cancelled');

    repo.close();
  });

  it('keeps a cancelled session cancelled when task throws', async () => {
    const { repo, dbPath } = createRepo();
    createdDbPaths.push(dbPath);
    const scope = createScope('user-pool-cancel-fail', 'ws-pool-cancel-fail');
    const run = repo.createRun({
      userId: scope.userId,
      workspaceId: scope.workspaceId,
      title: 'Cancel fail run',
      contract: 'cancel-fail',
    });
    const session = createSubagentSessionForDispatch(repo, scope, {
      runId: run.id,
      capability: 'web_search',
      payload: '{"q":"test"}',
      assignedTools: ['web_search'],
    });
    const job = repo.createDelegationJob(scope, {
      runId: run.id,
      capability: 'web_search',
      payload: '{"q":"test"}',
      status: 'queued',
      priority: 'medium',
      maxAttempts: 3,
      timeoutMs: 60_000,
    });

    // Cancel the session before execution
    repo.updateSubagentSession(scope, session.id, { status: 'cancelled' });

    const pool = new SubagentPool(repo, new DelegationInbox(repo));

    await pool.execute(scope, run.id, job.id, session.id, async () => {
      throw new Error('should not fail');
    });

    const updatedJob = repo.listDelegationJobs(scope, run.id).find((j) => j.id === job.id);
    expect(updatedJob?.status).toBe('cancelled');

    repo.close();
  });
});
