import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SqliteMasterRepository } from '@/server/master/sqliteMasterRepository';
import { MasterOrchestrator } from '@/server/master/orchestrator';

function uniqueDbPath(): string {
  return path.join(
    process.cwd(),
    '.local',
    `master.idempotency.${Date.now()}.${Math.random().toString(36).slice(2)}.db`,
  );
}

describe('master idempotency ledger', () => {
  const cleanupFiles: string[] = [];

  afterEach(() => {
    for (const filePath of cleanupFiles.splice(0, cleanupFiles.length)) {
      try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } catch {
        // ignore sqlite lock
      }
    }
  });

  it('replays committed side effects by idempotency key', async () => {
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

    const execute = vi.fn(async () => ({ messageId: 'gmail-1' }));
    const first = await orchestrator.executeSideEffect({
      scope,
      runId: run.id,
      stepId: 'step-1',
      actionType: 'gmail.send',
      payload: '{"to":"a@b.c"}',
      execute,
    });
    expect(first.replayed).toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);

    const second = await orchestrator.executeSideEffect({
      scope,
      runId: run.id,
      stepId: 'step-1',
      actionType: 'gmail.send',
      payload: '{"to":"a@b.c"}',
      execute,
    });
    expect(second.replayed).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);

    repo.close();
  });
});
