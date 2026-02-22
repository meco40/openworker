import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type BetterSqlite3 from 'better-sqlite3';

const openDbs: BetterSqlite3.Database[] = [];
const tempDirs: string[] = [];

function trackDb(db: BetterSqlite3.Database): BetterSqlite3.Database {
  openDbs.push(db);
  return db;
}

afterEach(() => {
  for (const db of openDbs.splice(0)) {
    if (db.open) db.close();
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('openSqliteDatabase', () => {
  it('applies production pragmas for writable file databases', async () => {
    const mod = await import('@/server/db/sqlite');
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-hardening-'));
    tempDirs.push(tempDir);
    const dbPath = path.join(tempDir, 'app.db');

    const db = trackDb(mod.openSqliteDatabase({ dbPath }));
    db.exec('CREATE TABLE sample (id INTEGER PRIMARY KEY, value TEXT)');
    db.exec("INSERT INTO sample (value) VALUES ('ok')");

    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('synchronous', { simple: true })).toBe(1);
  });

  it('opens readonly connections safely without requiring write pragmas', async () => {
    const mod = await import('@/server/db/sqlite');
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-hardening-'));
    tempDirs.push(tempDir);
    const dbPath = path.join(tempDir, 'readonly.db');

    const writableDb = trackDb(mod.openSqliteDatabase({ dbPath }));
    writableDb.exec('CREATE TABLE readonly_sample (id INTEGER PRIMARY KEY, value TEXT)');
    writableDb.exec("INSERT INTO readonly_sample (value) VALUES ('ok')");
    writableDb.close();
    openDbs.pop();

    const readonlyDb = trackDb(mod.openSqliteDatabase({ dbPath, readonly: true }));
    const row = readonlyDb.prepare('SELECT value FROM readonly_sample WHERE id = 1').get() as
      | { value: string }
      | undefined;

    expect(row?.value).toBe('ok');
  });

  it('supports in-memory databases without throwing', async () => {
    const mod = await import('@/server/db/sqlite');
    const db = trackDb(mod.openSqliteDatabase({ dbPath: ':memory:' }));

    db.exec('CREATE TABLE mem_sample (id INTEGER PRIMARY KEY, value TEXT)');
    db.exec("INSERT INTO mem_sample (value) VALUES ('ok')");
    const row = db.prepare('SELECT value FROM mem_sample WHERE id = 1').get() as
      | { value: string }
      | undefined;

    expect(row?.value).toBe('ok');
  });
});
