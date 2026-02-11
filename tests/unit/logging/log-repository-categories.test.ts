import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { LogRepository } from '../../../src/logging/logRepository';

function uniqueDbPath(name: string): string {
  return path.join(
    process.cwd(),
    '.local',
    `${name}.${Date.now()}.${Math.random().toString(36).slice(2)}.db`,
  );
}

const tempFiles: string[] = [];

afterEach(() => {
  for (const file of tempFiles.splice(0, tempFiles.length)) {
    if (fs.existsSync(file)) {
      try {
        fs.unlinkSync(file);
      } catch {
        // ignore cleanup flakiness on Windows
      }
    }
  }
});

describe('LogRepository category support', () => {
  it('stores categories and filters by category', () => {
    const repo = new LogRepository(':memory:');
    repo.insertLog('info', 'SYS', 'System start', undefined, 'system');
    repo.insertLog('error', 'AUTH', 'Invalid token', { userId: 'u1' }, 'security');

    const securityLogs = repo.listLogs({ category: 'security' });
    expect(securityLogs).toHaveLength(1);
    expect(securityLogs[0].category).toBe('security');
    expect(securityLogs[0].source).toBe('AUTH');

    expect(repo.getCategories()).toEqual(['security', 'system']);
    repo.close();
  });

  it('migrates old tables by adding category with default system', () => {
    const dbPath = uniqueDbPath('logs-category-migration');
    tempFiles.push(dbPath);

    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE system_logs (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        level TEXT NOT NULL,
        source TEXT NOT NULL,
        message TEXT NOT NULL,
        metadata TEXT,
        created_at TEXT NOT NULL
      );
    `);
    db.prepare(
      `INSERT INTO system_logs (id, timestamp, level, source, message, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'legacy-1',
      '2026-02-11T00:00:00.000Z',
      'info',
      'SYS',
      'legacy row',
      null,
      '2026-02-11T00:00:00.000Z',
    );
    db.close();

    const repo = new LogRepository(dbPath);
    const logs = repo.listLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0].category).toBe('system');
    repo.close();

    const migrated = new Database(dbPath);
    const columns = migrated
      .prepare(`PRAGMA table_info('system_logs')`)
      .all() as Array<{ name: string }>;
    expect(columns.some((column) => column.name === 'category')).toBe(true);
    migrated.close();
  });
});
