import fs from 'node:fs';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
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
      this.db = dbOrPath as BetterSqlite3.Database;
    } else {
      const dbPath = dbOrPath || process.env.ROOMS_DB_PATH || process.env.MESSAGES_DB_PATH || '.local/messages.db';
      
      if (dbPath === ':memory:') {
        this.db = new BetterSqlite3(':memory:');
      } else {
        const fullPath = path.resolve(dbPath);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        this.db = new BetterSqlite3(fullPath);
      }
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('busy_timeout = 5000');
      this.db.pragma('foreign_keys = ON');
      runMigrations(this.db);
    }
  }

  /**
   * Get the current ISO timestamp.
   */
  protected now(): string {
    return new Date().toISOString();
  }

  /**
   * Close the database connection.
   */
  close(): void {
    this.db.close();
  }
}
