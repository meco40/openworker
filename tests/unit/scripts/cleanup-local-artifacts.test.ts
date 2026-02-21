import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import {
  cleanupCandidates,
  collectCandidatesFromDir,
  shouldCleanupLocalFile,
} from '../../../scripts/cleanup-local-artifacts';

describe('cleanup-local-artifacts', () => {
  it('classifies known noisy local artifacts as removable', () => {
    expect(shouldCleanupLocalFile('test-dedup-123.db')).toBe(true);
    expect(shouldCleanupLocalFile('worker.delete.routes.123.abc.db-wal')).toBe(true);
    expect(shouldCleanupLocalFile('automation.routes.123.abc.db-shm')).toBe(true);

    expect(shouldCleanupLocalFile('messages.db')).toBe(false);
    expect(shouldCleanupLocalFile('stats.db')).toBe(false);
    expect(shouldCleanupLocalFile('personas.db')).toBe(false);
  });

  it('collects only removable artifacts from a directory', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'local-cleanup-collect-'));
    try {
      writeFileSync(path.join(dir, 'test-entity-graph-1.db'), 'x');
      writeFileSync(path.join(dir, 'worker.metrics.route.1.db-wal'), 'x');
      writeFileSync(path.join(dir, 'messages.db'), 'x');

      const candidates = collectCandidatesFromDir(dir);
      const names = new Set(candidates.map((entry) => entry.name));

      expect(names.has('test-entity-graph-1.db')).toBe(true);
      expect(names.has('worker.metrics.route.1.db-wal')).toBe(true);
      expect(names.has('messages.db')).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('supports dry-run and apply cleanup modes', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'local-cleanup-run-'));
    const removable = path.join(dir, 'test-nata-scenario-1.db-wal');
    const keep = path.join(dir, 'messages.db');

    try {
      writeFileSync(removable, 'x');
      writeFileSync(keep, 'x');

      const dryRunResult = cleanupCandidates(
        [{ name: path.basename(removable), path: removable, sizeBytes: 1 }],
        { dryRun: true },
      );

      expect(dryRunResult.deleted).toBe(0);
      expect(dryRunResult.matched).toBe(1);
      expect(existsSync(removable)).toBe(true);

      const applyResult = cleanupCandidates(
        [{ name: path.basename(removable), path: removable, sizeBytes: 1 }],
        { dryRun: false },
      );

      expect(applyResult.deleted).toBe(1);
      expect(existsSync(removable)).toBe(false);
      expect(existsSync(keep)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
