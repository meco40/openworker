import { afterEach, describe, expect, it } from 'vitest';
import { cleanupDb, createRepo, createScope } from './repository/master-repository.harness';
import { MasterOrchestrator } from '@/server/master/orchestrator';
import {
  cancelSubagentSession,
  claimNextSubagentSession,
  createSubagentSessionForDispatch,
  getSubagentSessionDetail,
} from '@/server/master/delegation/sessionService';

describe('master subagent session service', () => {
  const createdDbPaths: string[] = [];

  afterEach(() => {
    for (const dbPath of createdDbPaths.splice(0, createdDbPaths.length)) {
      cleanupDb(dbPath);
    }
  });

  it('creates durable sessions and replays paired job events in detail views', () => {
    const { repo, dbPath } = createRepo();
    createdDbPaths.push(dbPath);
    const scope = createScope('user-session-service', 'ws-session-service');
    const run = repo.createRun({
      userId: scope.userId,
      workspaceId: scope.workspaceId,
      title: 'Investigate delegation',
      contract: 'delegate web search',
    });

    const session = createSubagentSessionForDispatch(repo, scope, {
      runId: run.id,
      capability: 'web_search',
      payload: '{"q":"latest docs"}',
      assignedTools: ['read', 'web_search'],
    });
    const job = repo.createDelegationJob(scope, {
      runId: run.id,
      capability: 'web_search',
      payload: '{"q":"latest docs"}',
      status: 'queued',
      priority: 'medium',
      maxAttempts: 3,
      timeoutMs: 60_000,
    });
    repo.appendDelegationEvent(scope, {
      runId: run.id,
      jobId: job.id,
      type: 'started',
      payload: JSON.stringify({ stage: 'running' }),
    });
    repo.appendDelegationEvent(scope, {
      runId: run.id,
      jobId: job.id,
      type: 'result',
      payload: JSON.stringify({ output: 'found docs', confidence: 0.91 }),
    });

    const detail = getSubagentSessionDetail(repo, scope, session.id);
    expect(detail).not.toBeNull();
    expect(detail?.session.id).toBe(session.id);
    expect(detail?.job?.id).toBe(job.id);
    expect(detail?.events.map((event) => event.type)).toEqual(['started', 'result']);

    repo.close();
  });

  it('claims queued sessions, reclaims expired leases, and cancels active sessions', () => {
    const { repo, dbPath } = createRepo();
    createdDbPaths.push(dbPath);
    const scope = createScope('user-session-claim', 'ws-session-claim');
    const run = repo.createRun({
      userId: scope.userId,
      workspaceId: scope.workspaceId,
      title: 'Claim sessions',
      contract: 'exercise queue ownership',
    });
    const queued = repo.createSubagentSession(scope, {
      runId: run.id,
      status: 'queued',
      title: 'Queued session',
      prompt: 'Inspect queued work',
      assignedTools: ['read'],
      ownerId: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      latestEventAt: null,
      resultSummary: null,
      lastError: null,
    });
    const expired = repo.createSubagentSession(scope, {
      runId: run.id,
      status: 'running',
      title: 'Expired session',
      prompt: 'Resume interrupted work',
      assignedTools: ['read'],
      ownerId: 'worker-stale',
      leaseExpiresAt: '2026-03-06T10:00:00.000Z',
      heartbeatAt: '2026-03-06T09:59:30.000Z',
      latestEventAt: null,
      resultSummary: null,
      lastError: null,
    });

    const firstClaim = claimNextSubagentSession(repo, scope, {
      ownerId: 'worker-a',
      now: '2026-03-06T10:05:00.000Z',
      leaseMs: 30_000,
    });
    expect(firstClaim?.id).toBe(queued.id);
    expect(firstClaim?.status).toBe('running');
    expect(firstClaim?.ownerId).toBe('worker-a');

    const secondClaim = claimNextSubagentSession(repo, scope, {
      ownerId: 'worker-b',
      now: '2026-03-06T10:05:29.000Z',
      leaseMs: 30_000,
    });
    expect(secondClaim?.id).toBe(expired.id);
    expect(secondClaim?.ownerId).toBe('worker-b');

    const cancelled = cancelSubagentSession(repo, scope, expired.id, 'operator_cancelled');
    expect(cancelled?.status).toBe('cancelled');
    expect(cancelled?.ownerId).toBeNull();
    expect(cancelled?.lastError).toBe('operator_cancelled');

    repo.close();
  });

  it('creates the durable session before the job when delegating through the orchestrator', async () => {
    const { repo, dbPath } = createRepo();
    createdDbPaths.push(dbPath);
    const scope = createScope('user-session-dispatch', 'ws-session-dispatch');
    const orchestrator = new MasterOrchestrator(repo);
    const run = repo.createRun({
      userId: scope.userId,
      workspaceId: scope.workspaceId,
      title: 'Delegate with session',
      contract: 'capture session before job',
    });

    const dispatch = await orchestrator.delegate(scope, run.id, {
      capability: 'web_search',
      payload: '{"q":"delegate"}',
      task: async () => ({ output: 'delegated', confidence: 0.8 }),
    });

    expect(dispatch.accepted).toBe(true);
    const sessions = repo.listSubagentSessions(scope, run.id);
    const jobs = repo.listDelegationJobs(scope, run.id);
    expect(sessions).toHaveLength(1);
    expect(jobs).toHaveLength(1);
    expect(new Date(sessions[0]!.createdAt).getTime()).toBeLessThanOrEqual(
      new Date(jobs[0]!.createdAt).getTime(),
    );
    expect(sessions[0]!.status).toBe('completed');
    expect(sessions[0]!.resultSummary).toBe('delegated');

    repo.close();
  });
});
