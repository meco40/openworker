import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteMasterRepository } from '@/server/master/sqliteMasterRepository';
import { MasterOrchestrator } from '@/server/master/orchestrator';
import { getTestArtifactsRoot } from '../../helpers/testArtifacts';

function uniqueDbPath(): string {
  return path.join(
    getTestArtifactsRoot(),
    `master.orchestrator.${Date.now()}.${Math.random().toString(36).slice(2)}.db`,
  );
}

describe('MasterOrchestrator', () => {
  const cleanupFiles: string[] = [];

  afterEach(() => {
    for (const filePath of cleanupFiles.splice(0, cleanupFiles.length)) {
      try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } catch {
        // ignore sqlite locks
      }
    }
  });

  it('advances lifecycle deterministically and enforces verify gate', () => {
    const dbPath = uniqueDbPath();
    cleanupFiles.push(dbPath);
    const repo = new SqliteMasterRepository(dbPath);
    const orchestrator = new MasterOrchestrator(repo);
    const scope = { userId: 'user-1', workspaceId: 'ws-1' };
    const run = repo.createRun({
      userId: scope.userId,
      workspaceId: scope.workspaceId,
      title: 'run',
      contract: 'contract',
    });

    const planning = orchestrator.advanceRun(scope, run.id);
    expect(planning.status).toBe('PLANNING');
    const delegating = orchestrator.advanceRun(scope, run.id);
    expect(delegating.status).toBe('DELEGATING');
    const executing = orchestrator.advanceRun(scope, run.id);
    expect(executing.status).toBe('EXECUTING');
    const verifying = orchestrator.advanceRun(scope, run.id);
    expect(verifying.status).toBe('VERIFYING');
    const refining = orchestrator.advanceRun(scope, run.id, { verificationPassed: false });
    expect(refining.status).toBe('REFINING');
    const backToPlanning = orchestrator.advanceRun(scope, run.id);
    expect(backToPlanning.status).toBe('PLANNING');

    repo.close();
  });

  it('pauses in awaiting approval and resumes by explicit decision', () => {
    const dbPath = uniqueDbPath();
    cleanupFiles.push(dbPath);
    const repo = new SqliteMasterRepository(dbPath);
    const orchestrator = new MasterOrchestrator(repo);
    const scope = { userId: 'user-2', workspaceId: 'ws-2' };
    const run = repo.createRun({
      userId: scope.userId,
      workspaceId: scope.workspaceId,
      title: 'run2',
      contract: 'contract2',
    });
    repo.updateRun(scope, run.id, { status: 'EXECUTING' });

    const paused = orchestrator.advanceRun(scope, run.id, { needsApproval: true });
    expect(paused.status).toBe('AWAITING_APPROVAL');
    expect(paused.pausedForApproval).toBe(true);

    const resumed = orchestrator.applyApprovalDecision(scope, run.id, {
      actionType: 'gmail.send',
      fingerprint: 'f1',
      decision: 'approve_once',
    });
    expect(resumed.status).toBe('EXECUTING');
    expect(resumed.pausedForApproval).toBe(false);

    repo.close();
  });
});
