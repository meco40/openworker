/**
 * SQLite-based system log persistence.
 *
 * Stores log entries (level, source, message, metadata) so they
 * survive page reloads and server restarts.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

// ── Types ────────────────────────────────────────────────────────

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  id: string;
  timestamp: string;
  level: LogLevel;
  source: string;
  message: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface LogFilter {
  level?: LogLevel;
  source?: string;
  search?: string;
  limit?: number;
  before?: string; // cursor-based pagination (ISO timestamp)
}

// ── Row mapper ───────────────────────────────────────────────────

function toLogEntry(row: Record<string, unknown>): LogEntry {
  return {
    id: String(row.id),
    timestamp: String(row.timestamp),
    level: String(row.level) as LogLevel,
    source: String(row.source),
    message: String(row.message),
    metadata: row.metadata ? (JSON.parse(String(row.metadata)) as Record<string, unknown>) : null,
    createdAt: String(row.created_at),
  };
}

// ── Repository ───────────────────────────────────────────────────

export class LogRepository {
  private readonly db: DatabaseSync;

  constructor(dbPath = process.env.LOGS_DB_PATH || '.local/logs.db') {
    if (dbPath === ':memory:') {
      this.db = new DatabaseSync(':memory:');
    } else {
      const fullPath = path.isAbsolute(dbPath) ? dbPath : path.join(process.cwd(), dbPath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      this.db = new DatabaseSync(fullPath);
    }
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS system_logs (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        level TEXT NOT NULL CHECK(level IN ('debug', 'info', 'warn', 'error')),
        source TEXT NOT NULL,
        message TEXT NOT NULL,
        metadata TEXT,
        created_at TEXT NOT NULL
      );
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_logs_timestamp
        ON system_logs (created_at DESC);
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_logs_level
        ON system_logs (level);
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_logs_source
        ON system_logs (source);
    `);
  }

  // ── Insert ──────────────────────────────────────────────────

  insertLog(
    level: LogLevel,
    source: string,
    message: string,
    metadata?: Record<string, unknown>,
  ): LogEntry {
    const id = `log-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO system_logs (id, timestamp, level, source, message, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, now, level, source, message, metadata ? JSON.stringify(metadata) : null, now);

    return {
      id,
      timestamp: now,
      level,
      source,
      message,
      metadata: metadata ?? null,
      createdAt: now,
    };
  }

  // ── Query ───────────────────────────────────────────────────

  listLogs(filter: LogFilter = {}): LogEntry[] {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (filter.level) {
      conditions.push('level = ?');
      params.push(filter.level);
    }

    if (filter.source) {
      conditions.push('source = ?');
      params.push(filter.source);
    }

    if (filter.search) {
      conditions.push('message LIKE ?');
      params.push(`%${filter.search}%`);
    }

    if (filter.before) {
      conditions.push('created_at < ?');
      params.push(filter.before);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = filter.limit ?? 200;

    const sql = `SELECT * FROM system_logs ${where} ORDER BY rowid DESC LIMIT ?`;
    params.push(limit);

    const rows = this.db.prepare(sql).all(...(params as Array<string | number | null>)) as Array<
      Record<string, unknown>
    >;
    // Reverse to chronological order (oldest first)
    return rows.map(toLogEntry).reverse();
  }

  // ── Aggregates ──────────────────────────────────────────────

  getLogCount(level?: LogLevel): number {
    if (level) {
      const row = this.db
        .prepare('SELECT COUNT(*) as cnt FROM system_logs WHERE level = ?')
        .get(level) as Record<string, unknown>;
      return Number(row.cnt);
    }
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM system_logs').get() as Record<
      string,
      unknown
    >;
    return Number(row.cnt);
  }

  getSources(): string[] {
    const rows = this.db
      .prepare('SELECT DISTINCT source FROM system_logs ORDER BY source')
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => String(r.source));
  }

  // ── Clear ───────────────────────────────────────────────────

  clearLogs(): number {
    const result = this.db.prepare('DELETE FROM system_logs').run() as { changes: number };
    return result.changes;
  }

  // ── Lifecycle ───────────────────────────────────────────────

  close(): void {
    this.db.close();
  }
}

// ── Singleton ────────────────────────────────────────────────────

declare global {
  var __logRepository: LogRepository | undefined;
}

export function getLogRepository(): LogRepository {
  if (!globalThis.__logRepository) {
    globalThis.__logRepository = new LogRepository();
  }
  return globalThis.__logRepository;
}
