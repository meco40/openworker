import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  cleanupTestArtifactsRoot,
  collectTestArtifactsStats,
} from '../../../scripts/cleanup-test-artifacts';

const allowedArtifactsRoot = path.resolve('.local', 'test-artifacts');

async function runCleanupCli(args: string[]): Promise<Record<string, unknown>> {
  const originalArgv = process.argv;
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  process.argv = [process.execPath, path.resolve('scripts/cleanup-test-artifacts.ts'), ...args];

  try {
    vi.resetModules();
    await import('../../../scripts/cleanup-test-artifacts');
    return JSON.parse(String(output.mock.calls[0]?.[0])) as Record<string, unknown>;
  } finally {
    process.argv = originalArgv;
    output.mockRestore();
  }
}

describe('cleanup-test-artifacts', () => {
  it('returns zero stats when the root is missing', () => {
    const root = path.join(os.tmpdir(), `cleanup-test-artifacts-missing-${Date.now()}`);
    expect(collectTestArtifactsStats(root)).toEqual({ files: 0, bytes: 0 });
  });

  it('reports file and byte counts before cleanup', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-test-artifacts-stats-'));
    const nested = path.join(root, 'db');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, 'one.db'), 'abc');
    fs.writeFileSync(path.join(nested, 'two.db-wal'), 'defg');

    const stats = collectTestArtifactsStats(root);
    expect(stats.files).toBe(2);
    expect(stats.bytes).toBe(7);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it('ignores a file that disappears while collecting its size', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-test-artifacts-race-'));
    fs.writeFileSync(path.join(root, 'removed-during-stat.db'), 'abc');
    const stat = vi.spyOn(fs, 'statSync').mockImplementationOnce(() => {
      throw new Error('file disappeared');
    });

    try {
      expect(collectTestArtifactsStats(root)).toEqual({ files: 1, bytes: 0 });
    } finally {
      stat.mockRestore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('supports dry-run and apply cleanup', () => {
    const allowedRoot = path.resolve('.local', 'test-artifacts');
    fs.mkdirSync(allowedRoot, { recursive: true });
    const root = fs.mkdtempSync(path.join(allowedRoot, 'cleanup-test-artifacts-run-'));
    fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
    fs.writeFileSync(path.join(root, 'tmp', 'artifact.txt'), 'x');

    const dryRun = cleanupTestArtifactsRoot({ root, dryRun: true });
    expect(dryRun.removed).toBe(false);
    expect(dryRun.statsBefore.files).toBe(1);
    expect(fs.existsSync(root)).toBe(true);

    const applied = cleanupTestArtifactsRoot({ root, dryRun: false });
    expect(applied.removed).toBe(true);
    expect(applied.statsBefore.files).toBe(1);
    expect(fs.existsSync(root)).toBe(false);
  });

  it('rejects cleanup outside .local/test-artifacts unless explicitly forced', () => {
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-test-artifacts-outside-'));
    try {
      expect(() =>
        cleanupTestArtifactsRoot({
          root: outsideRoot,
          dryRun: true,
        }),
      ).toThrow(/outside of allowed test artifacts root/i);

      const forced = cleanupTestArtifactsRoot({
        root: outsideRoot,
        dryRun: true,
        allowAnyDir: true,
      });
      expect(forced.root).toBe(path.resolve(outsideRoot));
    } finally {
      fs.rmSync(outsideRoot, { recursive: true, force: true });
    }
  });

  it('does not treat a similarly prefixed sibling as an allowed artifact directory', () => {
    expect(() =>
      cleanupTestArtifactsRoot({
        root: `${allowedArtifactsRoot}-sibling`,
        dryRun: true,
      }),
    ).toThrow(/outside of allowed test artifacts root/i);
  });

  it.each(['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY'])(
    'skips cleanup for transient %s errors',
    (code) => {
      fs.mkdirSync(allowedArtifactsRoot, { recursive: true });
      const root = fs.mkdtempSync(
        path.join(allowedArtifactsRoot, 'cleanup-test-artifacts-locked-'),
      );
      fs.writeFileSync(path.join(root, 'artifact.txt'), 'x');
      const rm = vi.spyOn(fs, 'rmSync').mockImplementationOnce(() => {
        throw Object.assign(new Error('path is locked'), { code });
      });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      try {
        expect(cleanupTestArtifactsRoot({ root, dryRun: false })).toMatchObject({
          removed: false,
          statsBefore: { files: 1, bytes: 1 },
        });
        expect(warn).toHaveBeenCalledWith(expect.stringContaining(`(${code})`));
        expect(fs.existsSync(root)).toBe(true);
      } finally {
        rm.mockRestore();
        warn.mockRestore();
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it('rethrows permanent removal errors', () => {
    fs.mkdirSync(allowedArtifactsRoot, { recursive: true });
    const root = fs.mkdtempSync(path.join(allowedArtifactsRoot, 'cleanup-test-artifacts-error-'));
    fs.writeFileSync(path.join(root, 'artifact.txt'), 'x');
    const rm = vi.spyOn(fs, 'rmSync').mockImplementationOnce(() => {
      throw new Error('disk failure');
    });

    try {
      expect(() => cleanupTestArtifactsRoot({ root, dryRun: false })).toThrow('disk failure');
    } finally {
      rm.mockRestore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports an empty directory as not removed after apply', () => {
    fs.mkdirSync(allowedArtifactsRoot, { recursive: true });
    const root = fs.mkdtempSync(path.join(allowedArtifactsRoot, 'cleanup-test-artifacts-empty-'));

    try {
      expect(cleanupTestArtifactsRoot({ root, dryRun: false })).toMatchObject({
        removed: false,
        statsBefore: { files: 0, bytes: 0 },
      });
      expect(fs.existsSync(root)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('runs CLI dry-run and apply against a temporary directory', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-test-artifacts-cli-'));
    fs.writeFileSync(path.join(root, 'artifact.txt'), 'test');

    try {
      const dryRun = await runCleanupCli(['--dir', root, '--force-any-dir', '--dry-run']);
      expect(dryRun).toMatchObject({
        root,
        dryRun: true,
        removed: false,
        files: 1,
        bytes: 4,
      });
      expect(fs.existsSync(root)).toBe(true);

      const applied = await runCleanupCli(['--dir', root, '--force-any-dir', '--apply']);
      expect(applied).toMatchObject({
        root,
        dryRun: false,
        removed: true,
        files: 1,
        bytes: 4,
      });
      expect(fs.existsSync(root)).toBe(false);

      const defaultRoot = await runCleanupCli(['--dir']);
      expect(defaultRoot).toMatchObject({
        root: allowedArtifactsRoot,
        dryRun: true,
        removed: false,
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
