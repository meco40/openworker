import type BetterSqlite3 from 'better-sqlite3';
import { openSqliteDatabase } from '@/server/db/sqlite';
import { runMasterMigrations } from '@/server/master/migrations';

export type MasterSqliteDb = ReturnType<typeof BetterSqlite3>;

export function createMasterSqliteDb(dbPath: string): MasterSqliteDb {
  const db = openSqliteDatabase({ dbPath });
  runMasterMigrations(db);
  return db;
}
