import { afterEach, describe, expect, it } from 'vitest';
import { DelegationInbox } from '@/server/master/delegation/inbox';
import { SubagentPool } from '@/server/master/delegation/subagentPool';
import {
  cancelSubagentSession,
  createSubagentSessionForDispatch,
} from '@/server/master/delegation/sessionService';
import { cleanupDb, createRepo, createScope } from './repository/master-repository.harness';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCondition(
  predicate: () => boolean,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 1_000;
  const intervalMs = options.intervalMs ?? 10;
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error('Timed out waiting for condition.');
    }
    await sleep(intervalMs);
  }
}

function createDeferred<T>() {
  let resolveValue: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolveValue = resolve;
  });
  return {
    promise,
    resolve(value: T) {
      if (!resolveValue) {
        throw new Error('Expected deferred task resolver to be available.');
      }
      resolveValue(value);
    },
  };
}

describe('master subagent pool', () => {
  const createdDbPaths: string[] = [];

  afterEach(() => {
    for (const dbPath of createdDbPaths.splice(0, createdDbPaths.length)) {
      cleanupDb(dbPath);
    }
  });

  it('keeps a cancelled in-flight session cancelled when work finishes later', async () => {
    const { repo, dbPath } = createRepo();
    createdDbPaths.push(dbPath);
    const scope = createScope('user-subagent-pool-cancel', 'ws-subagent-pool-cancel');
    const run = repo.createRun({
      userId: scope.userId,
      workspaceId: scope.workspaceId,
      title: 'Cancel session',
      contract: 'cancel in-flight session',
    });
    const session = createSubagentSessionForDispatch(repo, scope, {
      runId: run.id,
      capability: 'web_search',
      payload: '{"q":"in-flight"}',
      assignedTools: ['web_search'],
    });
    const job = repo.createDelegationJob(scope, {
      runId: run.id,
      capability: 'web_search',
      payload: '{"q":"in-flight"}',
      status: 'queued',
      priority: 'medium',
      maxAttempts: 3,
      timeoutMs: 60_000,
    });
    const pool = new SubagentPool(repo, new DelegationInbox(repo), {
      heartbeatIntervalMs: 10,
      leaseMs: 50,
    });

    const deferred = createDeferred<{ output: string; confidence?: number }>();

    const execution = pool.execute(scope, run.id, job.id, session.id, () => deferred.promise);
    await sleep(20);
    const cancelled = cancelSubagentSession(repo, scope, session.id, 'operator_cancelled');
    expect(cancelled?.status).toBe('cancelled');

    deferred.resolve({ output: 'finished after cancel', confidence: 0.8 });
    await execution;

    expect(repo.getSubagentSession(scope, session.id)?.status).toBe('cancelled');
    expect(
      repo.listDelegationJobs(scope, run.id).find((entry) => entry.id === job.id)?.status,
    ).toBe('cancelled');
    repo.close();
  });

  it('renews session heartbeat while long-running work is still executing', async () => {
    const { repo, dbPath } = createRepo();
    createdDbPaths.push(dbPath);
    const scope = createScope('user-subagent-pool-heartbeat', 'ws-subagent-pool-heartbeat');
    const run = repo.createRun({
      userId: scope.userId,
      workspaceId: scope.workspaceId,
      title: 'Heartbeat session',
      contract: 'heartbeat long-running session',
    });
    const session = createSubagentSessionForDispatch(repo, scope, {
      runId: run.id,
      capability: 'web_search',
      payload: '{"q":"heartbeat"}',
      assignedTools: ['web_search'],
    });
    const job = repo.createDelegationJob(scope, {
      runId: run.id,
      capability: 'web_search',
      payload: '{"q":"heartbeat"}',
      status: 'queued',
      priority: 'medium',
      maxAttempts: 3,
      timeoutMs: 60_000,
    });
    const pool = new SubagentPool(repo, new DelegationInbox(repo), {
      heartbeatIntervalMs: 10,
      leaseMs: 25,
    });

    const execution = pool.execute(scope, run.id, job.id, session.id, async () => {
      await sleep(120);
      return { output: 'complete', confidence: 0.9 };
    });

    await waitForCondition(
      () =>
        repo.getSubagentSession(scope, session.id)?.status === 'running' &&
        repo.getSubagentSession(scope, session.id)?.heartbeatAt !== null,
      { timeoutMs: 1_500, intervalMs: 10 },
    );
    const firstHeartbeat = repo.getSubagentSession(scope, session.id)?.heartbeatAt ?? null;
    await waitForCondition(
      () => {
        const current = repo.getSubagentSession(scope, session.id);
        if (!current || current.status !== 'running' || !current.heartbeatAt || !firstHeartbeat) {
          return false;
        }
        return new Date(current.heartbeatAt).getTime() > new Date(firstHeartbeat).getTime();
      },
      { timeoutMs: 1_500, intervalMs: 10 },
    );
    const secondHeartbeat = repo.getSubagentSession(scope, session.id)?.heartbeatAt ?? null;

    expect(firstHeartbeat).not.toBeNull();
    expect(secondHeartbeat).not.toBeNull();
    expect(new Date(String(secondHeartbeat)).getTime()).toBeGreaterThan(
      new Date(String(firstHeartbeat)).getTime(),
    );

    await execution;
    repo.close();
  });
});
