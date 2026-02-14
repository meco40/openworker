import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteWorkerRepository } from '../../../src/server/worker/workerRepository';

describe('orchestra version pinning', () => {
  const createdPaths: string[] = [];

  afterEach(() => {
    for (const filePath of createdPaths.splice(0, createdPaths.length)) {
      try {
        fs.rmSync(filePath, { force: true });
      } catch {
        // ignore cleanup failures on windows sqlite locks
      }
    }
  });

  it('pins an active run to the published flow version selected at run start', () => {
    const dbPath = path.join(
      os.tmpdir(),
      `worker-orchestra-version-pinning-${Date.now()}-${Math.random().toString(16).slice(2)}.db`,
    );
    createdPaths.push(dbPath);

    const repo = new SqliteWorkerRepository(dbPath);
    const userId = 'user-pin';
    const task = repo.createTask({
      title: 'Pinned Flow Task',
      objective: 'Verify flow version pinning',
      originPlatform: 'WebChat' as never,
      originConversation: 'conv-pin-1',
      userId,
      workspaceType: 'research',
    });

    const draftV1 = repo.createFlowDraft({
      userId,
      workspaceType: 'research',
      name: 'Research Flow',
      graphJson: JSON.stringify({
        startNodeId: 'n1',
        nodes: [{ id: 'n1', personaId: 'persona-a' }],
        edges: [],
      }),
    });
    const publishedV1 = repo.publishFlowDraft(draftV1.id, userId);
    expect(publishedV1).not.toBeNull();
    if (!publishedV1) {
      return;
    }

    const run = repo.createRun({
      taskId: task.id,
      userId,
      flowPublishedId: publishedV1.id,
      status: 'running',
    });
    repo.setTaskRunContext(task.id, {
      flowPublishedId: publishedV1.id,
      currentRunId: run.id,
    });

    repo.updateFlowDraft(draftV1.id, userId, {
      graphJson: JSON.stringify({
        startNodeId: 'n1',
        nodes: [
          { id: 'n1', personaId: 'persona-a' },
          { id: 'n2', personaId: 'persona-b' },
        ],
        edges: [{ from: 'n1', to: 'n2' }],
      }),
    });
    const publishedV2 = repo.publishFlowDraft(draftV1.id, userId);
    expect(publishedV2).not.toBeNull();
    expect(publishedV2?.id).not.toBe(publishedV1.id);

    const pinnedTask = repo.getTask(task.id);
    expect(pinnedTask?.flowPublishedId).toBe(publishedV1.id);
    expect(pinnedTask?.currentRunId).toBe(run.id);

    const unchangedRun = repo.updateRunStatus(run.id, { status: 'running' });
    expect(unchangedRun?.flowPublishedId).toBe(publishedV1.id);
  });
});
