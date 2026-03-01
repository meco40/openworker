import { afterEach, describe, expect, it, vi } from 'vitest';

type RuntimeGlobals = typeof globalThis & {
  __taskWorkspaceCleanupRuntime?: unknown;
};

function resetCleanupRuntimeGlobal(): void {
  (globalThis as RuntimeGlobals).__taskWorkspaceCleanupRuntime = undefined;
}

describe('workspaceCleanupRuntime', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    resetCleanupRuntimeGlobal();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('runs startup cleanup and interval cleanup when enabled', async () => {
    vi.useFakeTimers();
    process.env.TASK_WORKSPACES_CLEANUP_ENABLED = 'true';
    process.env.TASK_WORKSPACES_CLEANUP_STARTUP = 'true';
    process.env.TASK_WORKSPACES_CLEANUP_INTERVAL_MS = '1000';

    const cleanupMock = vi.fn(() => ({
      scanned: 0,
      removed: 0,
      kept: 0,
      skipped: 0,
      reasonCounts: {
        activeTask: 0,
        missingMetadata: 0,
        invalidMetadata: 0,
        protected: 0,
        limitReached: 0,
        removeFailed: 0,
      },
    }));

    vi.doMock('@/lib/db', () => ({
      queryAll: vi.fn(() => []),
    }));
    vi.doMock('@/server/tasks/taskWorkspace', () => ({
      cleanupOrphanTaskWorkspaces: cleanupMock,
    }));

    const runtimeModule = await import('@/server/tasks/workspaceCleanupRuntime');
    const runtime = runtimeModule.startTaskWorkspaceCleanupRuntime();

    expect(cleanupMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2100);
    expect(cleanupMock).toHaveBeenCalledTimes(3);

    runtime.stop();
    await vi.advanceTimersByTimeAsync(2000);
    expect(cleanupMock).toHaveBeenCalledTimes(3);
  });

  it('does nothing when runtime is disabled', async () => {
    vi.useFakeTimers();
    process.env.TASK_WORKSPACES_CLEANUP_ENABLED = 'false';
    process.env.TASK_WORKSPACES_CLEANUP_STARTUP = 'true';
    process.env.TASK_WORKSPACES_CLEANUP_INTERVAL_MS = '250';

    const cleanupMock = vi.fn();

    vi.doMock('@/lib/db', () => ({
      queryAll: vi.fn(() => []),
    }));
    vi.doMock('@/server/tasks/taskWorkspace', () => ({
      cleanupOrphanTaskWorkspaces: cleanupMock,
    }));

    const runtimeModule = await import('@/server/tasks/workspaceCleanupRuntime');
    const runtime = runtimeModule.startTaskWorkspaceCleanupRuntime();
    await vi.advanceTimersByTimeAsync(1000);
    runtime.stop();

    expect(cleanupMock).not.toHaveBeenCalled();
  });

  it('returns an empty report if cleanup run fails', async () => {
    vi.doMock('@/lib/db', () => ({
      queryAll: vi.fn(() => {
        throw new Error('db unavailable');
      }),
    }));
    vi.doMock('@/server/tasks/taskWorkspace', () => ({
      cleanupOrphanTaskWorkspaces: vi.fn(),
    }));

    const runtimeModule = await import('@/server/tasks/workspaceCleanupRuntime');
    const report = runtimeModule.runTaskWorkspaceCleanupOnce('test');

    expect(report).toEqual({
      scanned: 0,
      removed: 0,
      kept: 0,
      skipped: 0,
      reasonCounts: {
        activeTask: 0,
        missingMetadata: 0,
        invalidMetadata: 0,
        protected: 0,
        limitReached: 0,
        removeFailed: 0,
      },
    });
  });
});
