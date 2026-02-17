import fs from 'node:fs';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { LEGACY_LOCAL_USER_ID } from '../../auth/constants';
import { runMigrations } from './migrations';

export type SQLParam = string | number | null | bigint | Uint8Array;

/**
 * Base repository class providing common database functionality.
 * All specialized repositories extend this class.
 */
export abstract class BaseRepository {
  protected db: BetterSqlite3.Database;

  constructor(dbOrPath?: BetterSqlite3.Database | string) {
    if (typeof dbOrPath === 'object' && dbOrPath !== null) {
      // Use provided database instance
      this.db = dbOrPath as BetterSqlite3.Database;
    } else {
      // Create new database connection
      const dbPath = dbOrPath || process.env.WORKER_DB_PATH || '.local/worker.db';

      if (dbPath === ':memory:') {
        this.db = new BetterSqlite3(':memory:');
      } else {
        const fullPath = path.resolve(dbPath);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        this.db = new BetterSqlite3(fullPath);
      }
      this.db.exec('PRAGMA journal_mode = WAL');
      runMigrations(this.db);
    }
  }

  /**
   * Check if legacy rows should be included for a given user ID.
   * Legacy rows have NULL user_id and are included for the local user.
   */
  protected shouldIncludeLegacyRows(userId: string): boolean {
    return userId === LEGACY_LOCAL_USER_ID;
  }

  /**
   * Get the current ISO timestamp.
   */
  protected now(): string {
    return new Date().toISOString();
  }
}
