import fs from 'node:fs';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';

export type SqliteSynchronousMode = 'OFF' | 'NORMAL' | 'FULL' | 'EXTRA';

export interface OpenSqliteDatabaseOptions {
  dbPath: string;
  readonly?: boolean;
  busyTimeoutMs?: number;
  enableWal?: boolean;
  enableForeignKeys?: boolean;
  synchronous?: SqliteSynchronousMode;
  additionalPragmas?: string[];
}

const DEFAULT_BUSY_TIMEOUT_MS = 5000;
const DEFAULT_SYNCHRONOUS: SqliteSynchronousMode = 'NORMAL';

function isInMemoryPath(dbPath: string): boolean {
  const normalized = dbPath.trim().toLowerCase();
  return (
    normalized === ':memory:' ||
    normalized.startsWith('file::memory:') ||
    normalized.includes('mode=memory')
  );
}

function resolveDbPath(dbPath: string, readonly: boolean): string {
  if (isInMemoryPath(dbPath)) {
    return dbPath;
  }

  const fullPath = path.resolve(dbPath);
  if (!readonly) {
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  }
  return fullPath;
}

export function applySqlitePragmas(
  db: BetterSqlite3.Database,
  options: OpenSqliteDatabaseOptions,
): void {
  const readonly = options.readonly === true;
  const inMemory = isInMemoryPath(options.dbPath);
  const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
  const enableForeignKeys = options.enableForeignKeys ?? true;
  const enableWal = options.enableWal ?? true;
  const synchronous = options.synchronous ?? DEFAULT_SYNCHRONOUS;

  db.pragma(`busy_timeout = ${Math.max(1, Math.floor(busyTimeoutMs))}`);

  if (enableForeignKeys) {
    db.pragma('foreign_keys = ON');
  }

  if (!readonly) {
    db.pragma(`synchronous = ${synchronous}`);
    if (enableWal && !inMemory) {
      db.pragma('journal_mode = WAL');
    }
  }

  for (const pragma of options.additionalPragmas ?? []) {
    const trimmed = pragma.trim();
    if (trimmed) {
      db.pragma(trimmed);
    }
  }
}

export function openSqliteDatabase(options: OpenSqliteDatabaseOptions): BetterSqlite3.Database {
  const readonly = options.readonly === true;
  const resolvedPath = resolveDbPath(options.dbPath, readonly);
  const db = readonly
    ? new BetterSqlite3(resolvedPath, { readonly: true })
    : new BetterSqlite3(resolvedPath);

  applySqlitePragmas(db, options);
  return db;
}
