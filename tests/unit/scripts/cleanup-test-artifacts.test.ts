import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  cleanupTestArtifactsRoot,
  collectTestArtifactsStats,
} from '../../../scripts/cleanup-test-artifacts';

describe('cleanup-test-artifacts', () => {
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
});
