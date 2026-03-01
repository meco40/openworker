import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteMasterRepository } from '@/server/master/repository/sqliteMasterRepository';
import { MasterOrchestrator } from '@/server/master/orchestrator';
import { aggregateDelegationResult } from '@/server/master/delegation/aggregator';
import { getTestArtifactsRoot } from '../../helpers/testArtifacts';

function uniqueDbPath(): string {
  return path.join(
    getTestArtifactsRoot(),
    `master.delegation.${Date.now()}.${Math.random().toString(36).slice(2)}.db`,
  );
}

describe('master delegation runtime', () => {
  const cleanupFiles: string[] = [];

  afterEach(() => {
    for (const filePath of cleanupFiles.splice(0, cleanupFiles.length)) {
      try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } catch {
        // ignore sqlite lock on windows
      }
    }
  });

  it('delegates work and persists events/results while run remains queryable', async () => {
    const dbPath = uniqueDbPath();
    cleanupFiles.push(dbPath);
    const repo = new SqliteMasterRepository(dbPath);
    const orchestrator = new MasterOrchestrator(repo);
    const scope = { userId: 'user-1', workspaceId: 'ws-1' };
    const run = repo.createRun({
      userId: scope.userId,
      workspaceId: scope.workspaceId,
      title: 'delegate',
      contract: 'delegate',
    });

    const dispatch = await orchestrator.delegate(scope, run.id, {
      capability: 'web_search',
      payload: '{"q":"docs"}',
      task: async () => ({ output: 'result', confidence: 0.9 }),
    });

    expect(dispatch.accepted).toBe(true);
    expect(dispatch.jobId.length).toBeGreaterThan(0);

    const fetchedRun = orchestrator.getRun(scope, run.id);
    expect(fetchedRun?.id).toBe(run.id);

    const jobs = repo.listDelegationJobs(scope, run.id);
    const events = repo.listDelegationEvents(scope, run.id);
    expect(jobs.length).toBe(1);
    expect(jobs[0].status).toBe('completed');
    expect(events.some((entry) => entry.type === 'result')).toBe(true);

    const aggregation = aggregateDelegationResult({ output: 'result', confidence: 0.9 });
    expect(aggregation.status).toBe('accepted');

    repo.close();
  });
});
