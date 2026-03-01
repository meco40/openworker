import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
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
    expect(shouldCleanupLocalFile('test-event-answer-1772306751274.db')).toBe(true);
    expect(shouldCleanupLocalFile('worker.delete.routes.123.abc.db-wal')).toBe(true);
    expect(shouldCleanupLocalFile('automation.routes.123.abc.db-shm')).toBe(true);
    expect(shouldCleanupLocalFile('knowledge-events.1771888363470.gjvbpen3209.db')).toBe(true);
    expect(shouldCleanupLocalFile('master.actions.personas.1772302000000.sample.db-wal')).toBe(
      true,
    );

    expect(shouldCleanupLocalFile('messages.db')).toBe(false);
    expect(shouldCleanupLocalFile('stats.db')).toBe(false);
    expect(shouldCleanupLocalFile('personas.db')).toBe(false);
    expect(shouldCleanupLocalFile('automation.db')).toBe(false);
  });

  it('collects removable artifacts recursively but skips protected directories', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'local-cleanup-collect-'));
    const nestedDir = path.join(dir, 'nested');
    const personasDir = path.join(dir, 'personas');
    try {
      writeFileSync(path.join(dir, 'test-entity-graph-1.db'), 'x');
      mkdirSync(nestedDir);
      writeFileSync(path.join(nestedDir, 'worker.metrics.route.1771888013330.sample.db-wal'), 'x');
      writeFileSync(path.join(nestedDir, 'knowledge-events.1771888013685.84v1k7ifxf6.db'), 'x');
      mkdirSync(personasDir);
      writeFileSync(path.join(personasDir, 'knowledge-events.1771888013685.84v1k7ifxf6.db'), 'x');
      writeFileSync(path.join(dir, 'messages.db'), 'x');

      const candidates = collectCandidatesFromDir(dir);
      const paths = new Set(candidates.map((entry) => entry.path));

      expect(paths.has(path.join(dir, 'test-entity-graph-1.db'))).toBe(true);
      expect(
        paths.has(path.join(nestedDir, 'worker.metrics.route.1771888013330.sample.db-wal')),
      ).toBe(true);
      expect(paths.has(path.join(nestedDir, 'knowledge-events.1771888013685.84v1k7ifxf6.db'))).toBe(
        true,
      );
      expect(
        paths.has(path.join(personasDir, 'knowledge-events.1771888013685.84v1k7ifxf6.db')),
      ).toBe(false);
      expect(paths.has(path.join(dir, 'messages.db'))).toBe(false);
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
