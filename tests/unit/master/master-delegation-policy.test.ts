import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  evaluateTriggerPolicy,
  resetTriggerPolicyState,
} from '@/server/master/delegation/triggerPolicy';
import { DelegationDispatcher } from '@/server/master/delegation/dispatcher';
import { DelegationResourceGovernor } from '@/server/master/delegation/resourceGovernor';
import { recoverDelegationQueue } from '@/server/master/delegation/recovery';
import { SqliteMasterRepository } from '@/server/master/sqliteMasterRepository';
import { getTestArtifactsRoot } from '../../helpers/testArtifacts';

function uniqueDbPath(): string {
  return path.join(
    getTestArtifactsRoot(),
    `master.policy.${Date.now()}.${Math.random().toString(36).slice(2)}.db`,
  );
}

describe('master delegation policy', () => {
  const cleanupFiles: string[] = [];

  afterEach(() => {
    resetTriggerPolicyState();
    for (const filePath of cleanupFiles.splice(0, cleanupFiles.length)) {
      try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } catch {
        // ignore sqlite lock on windows
      }
    }
  });

  it('enforces cooldown and capacity decisions', () => {
    const governor = new DelegationResourceGovernor(1);
    expect(governor.tryAcquire('web_search')).toBe(true);
    expect(governor.tryAcquire('web_search')).toBe(false);

    const first = evaluateTriggerPolicy({
      scopeKey: 'user-1::ws-1',
      capability: 'web_search',
      now: 1000,
      timeoutMs: 1000,
      cooldownMs: 250,
      maxConcurrent: 4,
      activeForCapability: 0,
      activeGlobal: 0,
    });
    expect(first.allowed).toBe(true);

    const cooldownBlocked = evaluateTriggerPolicy({
      scopeKey: 'user-1::ws-1',
      capability: 'web_search',
      now: 1100,
      timeoutMs: 1000,
      cooldownMs: 250,
      maxConcurrent: 4,
      activeForCapability: 0,
      activeGlobal: 0,
    });
    expect(cooldownBlocked.allowed).toBe(false);
    expect(cooldownBlocked.reason).toBe('cooldown_active');

    const capacityBlocked = evaluateTriggerPolicy({
      scopeKey: 'user-1::ws-1',
      capability: 'code',
      now: 2000,
      timeoutMs: 1000,
      cooldownMs: 250,
      maxConcurrent: 1,
      activeForCapability: 1,
      activeGlobal: 1,
    });
    expect(capacityBlocked.reason).toBe('capacity_exhausted');
  });

  it('recovers running jobs after restart semantics', () => {
    const dbPath = uniqueDbPath();
    cleanupFiles.push(dbPath);
    const repo = new SqliteMasterRepository(dbPath);
    const scope = { userId: 'user-1', workspaceId: 'ws-1' };
    const run = repo.createRun({
      userId: scope.userId,
      workspaceId: scope.workspaceId,
      title: 'run',
      contract: 'contract',
    });
    const job = repo.createDelegationJob(scope, {
      runId: run.id,
      capability: 'web_search',
      payload: '{}',
      status: 'running',
      priority: 'medium',
      maxAttempts: 2,
      timeoutMs: 2000,
    });

    const recovered = recoverDelegationQueue(repo, scope, run.id);
    expect(recovered).toBe(1);
    const jobs = repo.listDelegationJobs(scope, run.id);
    expect(jobs.find((entry) => entry.id === job.id)?.status).toBe('queued');

    repo.close();
  });

  it('does not share cooldown across different workspace scopes', async () => {
    const dbPath = uniqueDbPath();
    cleanupFiles.push(dbPath);
    const repo = new SqliteMasterRepository(dbPath);
    const dispatcher = new DelegationDispatcher(repo);

    const scopeA = { userId: 'user-1', workspaceId: 'ws-a' };
    const scopeB = { userId: 'user-1', workspaceId: 'ws-b' };
    const runA = repo.createRun({
      userId: scopeA.userId,
      workspaceId: scopeA.workspaceId,
      title: 'run-a',
      contract: 'contract-a',
    });
    const runB = repo.createRun({
      userId: scopeB.userId,
      workspaceId: scopeB.workspaceId,
      title: 'run-b',
      contract: 'contract-b',
    });

    const first = await dispatcher.dispatch({
      scope: scopeA,
      runId: runA.id,
      capability: 'web_search',
      payload: '{}',
      task: async () => ({ output: 'ok-a', confidence: 0.9 }),
    });
    const second = await dispatcher.dispatch({
      scope: scopeB,
      runId: runB.id,
      capability: 'web_search',
      payload: '{}',
      task: async () => ({ output: 'ok-b', confidence: 0.9 }),
    });

    expect(first.accepted).toBe(true);
    expect(second.accepted).toBe(true);

    repo.close();
  });
});
