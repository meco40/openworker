import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getTestArtifactsRoot } from '../../helpers/testArtifacts';

type MasterGlobals = typeof globalThis & {
  __masterRepository?: unknown;
  __masterOrchestrator?: unknown;
  __masterExecutionRuntime?: unknown;
};

function createDeferred<T>() {
  let resolveValue: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolveValue = resolve;
  });
  return {
    promise,
    resolve(value: T) {
      if (!resolveValue) throw new Error('resolve missing');
      resolveValue(value);
    },
  };
}

describe('master runtime tool loop', () => {
  const cleanupPaths: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();
    delete process.env.MASTER_DB_PATH;
    delete process.env.PERSONAS_DB_PATH;
    delete process.env.PERSONAS_ROOT_PATH;

    try {
      const runtime = await import('@/server/master/runtime');
      runtime.resetMasterRepositoryForTests();
    } catch {
      // ignore cleanup if runtime was not imported
    }
    (globalThis as MasterGlobals).__masterRepository = undefined;
    (globalThis as MasterGlobals).__masterOrchestrator = undefined;
    (globalThis as MasterGlobals).__masterExecutionRuntime = undefined;

    for (const target of cleanupPaths.splice(0, cleanupPaths.length)) {
      if (!fs.existsSync(target)) continue;
      try {
        const stat = fs.statSync(target);
        if (stat.isDirectory()) fs.rmSync(target, { recursive: true, force: true });
        else fs.rmSync(target, { force: true });
      } catch {
        // ignore transient locks
      }
    }
  });

  it('claims the run in the database while a background tool execution is in flight and releases it afterwards', async () => {
    const suffix = `${Date.now()}.${Math.random().toString(36).slice(2)}`;
    process.env.MASTER_DB_PATH = path.resolve(
      getTestArtifactsRoot(),
      `master.runtime.loop.${suffix}.db`,
    );
    process.env.PERSONAS_DB_PATH = path.resolve(
      getTestArtifactsRoot(),
      `master.runtime.loop.personas.${suffix}.db`,
    );
    process.env.PERSONAS_ROOT_PATH = path.resolve(
      getTestArtifactsRoot(),
      `master.runtime.loop.personas.root.${suffix}`,
    );
    cleanupPaths.push(
      String(process.env.MASTER_DB_PATH),
      String(process.env.PERSONAS_DB_PATH),
      String(process.env.PERSONAS_ROOT_PATH),
    );

    const deferred = createDeferred<{
      output: string;
      confidence: number;
      mode: 'fallback';
      degradedMode: false;
    }>();
    vi.doMock('@/server/skills/executeSkill', () => ({
      dispatchSkill: vi.fn(() => deferred.promise),
    }));

    const { getMasterRepository, getMasterExecutionRuntime } =
      await import('@/server/master/runtime');
    const { resolveMasterWorkspaceScope } = await import('@/server/master/workspaceScope');

    const repo = getMasterRepository();
    const scope = resolveMasterWorkspaceScope({
      userId: 'user-master',
      workspaceId: 'runtime-loop',
    });
    const run = repo.createRun({
      userId: scope.userId,
      workspaceId: scope.workspaceId,
      title: 'Runtime loop',
      contract: 'search current docs',
    });

    const runtime = getMasterExecutionRuntime();
    expect(runtime.startBackground(scope, run.id)).toBe(true);

    const claimedRun = repo.getRun(scope, run.id);
    expect(claimedRun?.ownerId).toBeTruthy();
    expect(claimedRun?.leaseExpiresAt).toBeTruthy();
    expect(claimedRun?.heartbeatAt).toBeTruthy();
    expect(runtime.startBackground(scope, run.id)).toBe(false);

    deferred.resolve({
      output: 'done',
      confidence: 0.8,
      mode: 'fallback',
      degradedMode: false,
    });
    await runtime.waitForRun(scope, run.id);

    const releasedRun = repo.getRun(scope, run.id);
    expect(releasedRun?.ownerId).toBeNull();
  });
});
