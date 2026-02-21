import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { cleanupSqliteArtifacts } from '../../helpers/sqliteTestArtifacts';

describe('cleanupSqliteArtifacts', () => {
  it('removes db and related sqlite sidecar files', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'sqlite-artifacts-'));
    const dbPath = path.join(dir, 'sample.db');
    const paths = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`];

    try {
      for (const filePath of paths) {
        writeFileSync(filePath, 'x');
      }

      cleanupSqliteArtifacts(dbPath);

      for (const filePath of paths) {
        expect(existsSync(filePath)).toBe(false);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is safe to call when files are already missing', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'sqlite-artifacts-empty-'));
    const dbPath = path.join(dir, 'missing.db');

    try {
      expect(() => cleanupSqliteArtifacts(dbPath)).not.toThrow();
      expect(() => cleanupSqliteArtifacts(dbPath)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
