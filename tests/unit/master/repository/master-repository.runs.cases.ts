import { afterEach, describe, expect, it } from 'vitest';
import { cleanupDb, createRepo, createScope } from './master-repository.harness';

describe('SqliteMasterRepository runs/steps/feedback', () => {
  const createdDbPaths: string[] = [];

  afterEach(() => {
    for (const dbPath of createdDbPaths.splice(0, createdDbPaths.length)) {
      cleanupDb(dbPath);
    }
  });

  it('persists runs, steps, feedback, and scoped updates', () => {
    const { repo, dbPath } = createRepo();
    createdDbPaths.push(dbPath);
    const scope = createScope('user-a', 'ws-1');
    const foreign = createScope('user-a', 'ws-2');

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
});
