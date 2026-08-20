import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { schema } from './schema';
import { runMigrations } from './migrations';

function resolveDbPath(): string {
  return process.env.DATABASE_PATH || path.join(process.cwd(), 'mission-control.db');
}

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  const targetPath = resolveDbPath();
  if (db && db.name !== targetPath) {
    db.close();
    db = null;
  }
  if (!db) {
    const isNewDb = !fs.existsSync(/* turbopackIgnore: true */ targetPath);

    db = new Database(targetPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 30000');
    db.pragma('cache_size = -16000');
    db.pragma('mmap_size = 134217728');
    db.pragma('temp_store = MEMORY');

    // Initialize base schema (creates tables if they don't exist)
    db.exec(schema);

    // Run migrations for schema updates
    // This handles both new and existing databases
    runMigrations(db);

    if (isNewDb) {
      console.log('[DB] New database created at:', targetPath);
    }
  }
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

// Type-safe query helpers
export function queryAll<T>(sql: string, params: unknown[] = []): T[] {
  const stmt = getDb().prepare(sql);
  return stmt.all(...params) as T[];
}

export function queryOne<T>(sql: string, params: unknown[] = []): T | undefined {
  const stmt = getDb().prepare(sql);
  return stmt.get(...params) as T | undefined;
}

export function run(sql: string, params: unknown[] = []): Database.RunResult {
  const stmt = getDb().prepare(sql);
  return stmt.run(...params);
}

export function transaction<T>(fn: () => T): T {
  const db = getDb();
  return db.transaction(fn)();
}

// Export migration utilities for CLI use
export { runMigrations, getMigrationStatus } from './migrations';
