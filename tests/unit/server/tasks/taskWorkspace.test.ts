import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanupOrphanTaskWorkspaces, ensureTaskWorkspace } from '@/server/tasks/taskWorkspace';

describe('taskWorkspace', () => {
  let tempDir = '';
  let previousTaskWorkspacesRoot: string | undefined;
  let previousMaxRemovals: string | undefined;

  beforeEach(() => {
    previousTaskWorkspacesRoot = process.env.TASK_WORKSPACES_ROOT;
    previousMaxRemovals = process.env.TASK_WORKSPACES_CLEANUP_MAX_REMOVALS_PER_RUN;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-workspace-unit-'));
    process.env.TASK_WORKSPACES_ROOT = path.join(tempDir, 'workspaces');
  });

  afterEach(() => {
    if (previousTaskWorkspacesRoot === undefined) {
      delete process.env.TASK_WORKSPACES_ROOT;
    } else {
      process.env.TASK_WORKSPACES_ROOT = previousTaskWorkspacesRoot;
    }

    if (previousMaxRemovals === undefined) {
      delete process.env.TASK_WORKSPACES_CLEANUP_MAX_REMOVALS_PER_RUN;
    } else {
      process.env.TASK_WORKSPACES_CLEANUP_MAX_REMOVALS_PER_RUN = previousMaxRemovals;
    }

    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = '';
    }
  });

  it('preserves createdAt on repeated ensure calls', () => {
    const workspaceDir = ensureTaskWorkspace('task-created-at', 'general');
    const metadataPath = path.join(workspaceDir, '.workspace.json');
    const firstMetadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8')) as {
      createdAt: string;
      type: string;
      taskId: string;
    };

    ensureTaskWorkspace('task-created-at', 'analysis');
    const secondMetadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8')) as {
      createdAt: string;
      type: string;
      taskId: string;
    };

    expect(secondMetadata.taskId).toBe('task-created-at');
    expect(secondMetadata.type).toBe('analysis');
    expect(secondMetadata.createdAt).toBe(firstMetadata.createdAt);
    expect(fs.existsSync(path.join(workspaceDir, 'logs'))).toBe(true);
  });

  it('removes orphaned task workspaces and keeps active ones', () => {
    const activeDir = ensureTaskWorkspace('task-active');
    const orphanDir = ensureTaskWorkspace('task-orphan');

    const report = cleanupOrphanTaskWorkspaces(['task-active']);

    expect(report).toMatchObject({
      scanned: 2,
      removed: 1,
      kept: 1,
      skipped: 0,
    });
    expect(report.reasonCounts.activeTask).toBe(1);
    expect(fs.existsSync(activeDir)).toBe(true);
    expect(fs.existsSync(orphanDir)).toBe(false);
  });

  it('skips directories without metadata and reports reasonCounts', () => {
    const root = String(process.env.TASK_WORKSPACES_ROOT);
    fs.mkdirSync(path.join(root, 'foreign-dir'), { recursive: true });

    const report = cleanupOrphanTaskWorkspaces([]);

    expect(report).toMatchObject({
      scanned: 1,
      removed: 0,
      kept: 0,
      skipped: 1,
    });
    expect(report.reasonCounts.missingMetadata).toBe(1);
    expect(fs.existsSync(path.join(root, 'foreign-dir'))).toBe(true);
  });

  it('respects max removals per cleanup run', () => {
    process.env.TASK_WORKSPACES_CLEANUP_MAX_REMOVALS_PER_RUN = '1';
    const root = String(process.env.TASK_WORKSPACES_ROOT);
    ensureTaskWorkspace('task-orphan-1');
    ensureTaskWorkspace('task-orphan-2');
    ensureTaskWorkspace('task-orphan-3');

    const report = cleanupOrphanTaskWorkspaces([]);
    const remainingDirs = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory());

    expect(report).toMatchObject({
      scanned: 3,
      removed: 1,
      kept: 0,
      skipped: 2,
    });
    expect(report.reasonCounts.limitReached).toBe(2);
    expect(remainingDirs.length).toBe(2);
  });

  it('uses deterministic workspace root in production mode', () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousCwd = process.cwd();
    const env = process.env as Record<string, string | undefined>;
    const isolatedCwd = fs.mkdtempSync(path.join(tempDir, 'cwd-'));
    const overrideRoot = path.join(tempDir, 'override-workspaces');

    try {
      process.chdir(isolatedCwd);
      env.NODE_ENV = 'production';
      env.TASK_WORKSPACES_ROOT = overrideRoot;

      const workspaceDir = ensureTaskWorkspace('task-prod-root');
      const expectedWorkspaceDir = path.join(previousCwd, 'workspaces', 'task-prod-root');

      expect(workspaceDir).toBe(expectedWorkspaceDir);
      expect(fs.existsSync(expectedWorkspaceDir)).toBe(true);
      expect(fs.existsSync(path.join(overrideRoot, 'task-prod-root'))).toBe(false);
    } finally {
      process.chdir(previousCwd);
      if (previousNodeEnv === undefined) {
        delete env.NODE_ENV;
      } else {
        env.NODE_ENV = previousNodeEnv;
      }
      fs.rmSync(path.join(previousCwd, 'workspaces', 'task-prod-root'), {
        recursive: true,
        force: true,
      });
      fs.rmSync(isolatedCwd, { recursive: true, force: true });
    }
  });
});
