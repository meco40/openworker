import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

import type { LogCategory, LogEntry, LogFilter, LogLevel } from './logTypes';

function toLogEntry(row: Record<string, unknown>): LogEntry {
  return {
    id: String(row.id),
    timestamp: String(row.timestamp),
    level: String(row.level) as LogLevel,
    source: String(row.source),
    category: String(row.category || 'system') as LogCategory,
    message: String(row.message),
    metadata: row.metadata ? (JSON.parse(String(row.metadata)) as Record<string, unknown>) : null,
    createdAt: String(row.created_at),
  };
}

function buildWhere(
  filter: Pick<LogFilter, 'level' | 'source' | 'category' | 'search' | 'before'>,
): { where: string; params: Array<string | number> } {
  const conditions: string[] = [];
  const params: Array<string | number> = [];

  if (filter.level) {
    conditions.push('level = ?');
    params.push(filter.level);
  }
  if (filter.source) {
    conditions.push('source = ?');
    params.push(filter.source);
  }
  if (filter.category) {
    conditions.push('category = ?');
    params.push(filter.category);
  }
  if (filter.search) {
    conditions.push('message LIKE ?');
    params.push(`%${filter.search}%`);
  }
  if (filter.before) {
    conditions.push('created_at < ?');
    params.push(filter.before);
  }

  return {
    where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
  };
}

export class LogRepository {
  private readonly db: ReturnType<typeof Database>;

  constructor(dbPath = process.env.LOGS_DB_PATH || '.local/logs.db') {
    if (dbPath === ':memory:') {
      this.db = new Database(':memory:');
    } else {
      const fullPath = path.resolve(dbPath);
       
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      this.db = new Database(fullPath);
    }
    this.migrate();
  }

  private hasColumn(table: string, column: string): boolean {
    const rows = this.db
      .prepare(`PRAGMA table_info(${table})`)
      .all() as Array<{ name: string | undefined }>;
    return rows.some((row) => row.name === column);
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS system_logs (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        level TEXT NOT NULL CHECK(level IN ('debug', 'info', 'warn', 'error')),
        source TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'system',
        message TEXT NOT NULL,
        metadata TEXT,
        created_at TEXT NOT NULL
      );
    `);

    if (!this.hasColumn('system_logs', 'category')) {
      this.db.exec(`ALTER TABLE system_logs ADD COLUMN category TEXT NOT NULL DEFAULT 'system';`);
      this.db.exec(`UPDATE system_logs SET category = 'system' WHERE category IS NULL OR category = '';`);
    }

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
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_logs_category
        ON system_logs (category);
    `);
  }

  insertLog(
    level: LogLevel,
    source: string,
    message: string,
    metadata?: Record<string, unknown>,
    category: LogCategory = 'system',
  ): LogEntry {
    const id = `log-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO system_logs (id, timestamp, level, source, category, message, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, now, level, source, category, message, metadata ? JSON.stringify(metadata) : null, now);

    return {
      id,
      timestamp: now,
      level,
      source,
      category,
      message,
      metadata: metadata ?? null,
      createdAt: now,
    };
  }

  listLogs(filter: LogFilter = {}): LogEntry[] {
    const { where, params } = buildWhere(filter);
    const limit = filter.limit ?? 200;
    const sql = `SELECT * FROM system_logs ${where} ORDER BY rowid DESC LIMIT ?`;
    params.push(limit);

    const rows = this.db.prepare(sql).all(...(params as Array<string | number | null>)) as Array<
      Record<string, unknown>
    >;
    return rows.map(toLogEntry).reverse();
  }

  getLogCount(
    levelOrFilter?: LogLevel | Pick<LogFilter, 'level' | 'source' | 'category' | 'search' | 'before'>,
  ): number {
    const filter =
      typeof levelOrFilter === 'string' ? { level: levelOrFilter } : (levelOrFilter ?? {});
    const { where, params } = buildWhere(filter);

    const row = this.db.prepare(`SELECT COUNT(*) as cnt FROM system_logs ${where}`).get(...params) as Record<
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

  getCategories(): LogCategory[] {
    const rows = this.db
      .prepare('SELECT DISTINCT category FROM system_logs ORDER BY category')
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => String(r.category || 'system') as LogCategory);
  }

  clearLogs(): number {
    const result = this.db.prepare('DELETE FROM system_logs').run() as { changes: number };
    return result.changes;
  }

  close(): void {
    this.db.close();
  }
}

declare global {
  var __logRepository: LogRepository | undefined;
}

export function getLogRepository(): LogRepository {
  if (!globalThis.__logRepository) {
    globalThis.__logRepository = new LogRepository();
  }
  return globalThis.__logRepository;
}

