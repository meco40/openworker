/**
 * SQLite-based token usage persistence.
 *
 * Records token consumption for every AI model dispatch so we can
 * aggregate stats by provider, model, and time range.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';

// ── Types ────────────────────────────────────────────────────────

export interface TokenUsageEntry {
  id: string;
  providerId: string;
  modelName: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  createdAt: string;
}

export interface TokenUsageSummary {
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface TokenUsageTotal {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

// ── Row mapper ───────────────────────────────────────────────────

function toEntry(row: Record<string, unknown>): TokenUsageEntry {
  return {
    id: String(row.id),
    providerId: String(row.provider_id),
    modelName: String(row.model_name),
    promptTokens: Number(row.prompt_tokens),
    completionTokens: Number(row.completion_tokens),
    totalTokens: Number(row.total_tokens),
    createdAt: String(row.created_at),
  };
}

// ── Repository ───────────────────────────────────────────────────

export class TokenUsageRepository {
  private readonly db: ReturnType<typeof Database>;

  constructor(dbPath = process.env.STATS_DB_PATH || '.local/stats.db') {
    if (dbPath === ':memory:') {
      this.db = new Database(':memory:');
    } else {
      const fullPath = path.resolve(dbPath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      this.db = new Database(fullPath);
    }
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS token_usage (
        id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL,
        model_name TEXT NOT NULL,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_token_usage_created
        ON token_usage (created_at);
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_token_usage_model
        ON token_usage (provider_id, model_name);
    `);
  }

  // ── Insert ──────────────────────────────────────────────────

  recordUsage(
    providerId: string,
    modelName: string,
    promptTokens: number,
    completionTokens: number,
    totalTokens: number,
  ): TokenUsageEntry {
    const id = `tu-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO token_usage (id, provider_id, model_name, prompt_tokens, completion_tokens, total_tokens, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, providerId, modelName, promptTokens, completionTokens, totalTokens, now);

    return {
      id,
      providerId,
      modelName,
      promptTokens,
      completionTokens,
      totalTokens,
      createdAt: now,
    };
  }

  // ── Queries ─────────────────────────────────────────────────

  /**
   * Returns token usage grouped by provider + model within the given time range.
   */
  getUsageSummary(from?: string, to?: string): TokenUsageSummary[] {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (from) {
      conditions.push('created_at >= ?');
      params.push(from);
    }
    if (to) {
      conditions.push('created_at <= ?');
      params.push(to);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const sql = `
      SELECT
        provider_id,
        model_name,
        SUM(prompt_tokens) as prompt_tokens,
        SUM(completion_tokens) as completion_tokens,
        SUM(total_tokens) as total_tokens
      FROM token_usage
      ${where}
      GROUP BY provider_id, model_name
      ORDER BY total_tokens DESC
    `;

    const rows = this.db.prepare(sql).all(...(params as Array<string | number | null>)) as Array<
      Record<string, unknown>
    >;

    return rows.map((row) => ({
      provider: String(row.provider_id),
      model: String(row.model_name),
      promptTokens: Number(row.prompt_tokens),
      completionTokens: Number(row.completion_tokens),
      totalTokens: Number(row.total_tokens),
    }));
  }

  /**
   * Returns the total token usage across all models within the given time range.
   */
  getTotalTokens(from?: string, to?: string): TokenUsageTotal {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (from) {
      conditions.push('created_at >= ?');
      params.push(from);
    }
    if (to) {
      conditions.push('created_at <= ?');
      params.push(to);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const sql = `
      SELECT
        COALESCE(SUM(prompt_tokens), 0) as prompt_tokens,
        COALESCE(SUM(completion_tokens), 0) as completion_tokens,
        COALESCE(SUM(total_tokens), 0) as total_tokens
      FROM token_usage
      ${where}
    `;

    const row = this.db.prepare(sql).get(...(params as Array<string | number | null>)) as Record<
      string,
      unknown
    >;

    return {
      promptTokens: Number(row.prompt_tokens),
      completionTokens: Number(row.completion_tokens),
      totalTokens: Number(row.total_tokens),
    };
  }

  /**
   * Returns all raw entries (for debugging / export), with optional time filtering.
   */
  listEntries(from?: string, to?: string, limit = 500): TokenUsageEntry[] {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (from) {
      conditions.push('created_at >= ?');
      params.push(from);
    }
    if (to) {
      conditions.push('created_at <= ?');
      params.push(to);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const sql = `SELECT * FROM token_usage ${where} ORDER BY created_at DESC LIMIT ?`;
    params.push(limit);

    const rows = this.db.prepare(sql).all(...(params as Array<string | number | null>)) as Array<
      Record<string, unknown>
    >;

    return rows.map(toEntry);
  }

  /**
   * Returns the total number of recorded entries.
   */
  getEntryCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM token_usage').get() as Record<
      string,
      unknown
    >;
    return Number(row.cnt);
  }

  // ── Lifecycle ───────────────────────────────────────────────

  close(): void {
    this.db.close();
  }
}

// ── Singleton ────────────────────────────────────────────────────

declare global {
  var __tokenUsageRepository: TokenUsageRepository | undefined;
}

export function getTokenUsageRepository(): TokenUsageRepository {
  if (!globalThis.__tokenUsageRepository) {
    globalThis.__tokenUsageRepository = new TokenUsageRepository();
  }
  return globalThis.__tokenUsageRepository;
}

