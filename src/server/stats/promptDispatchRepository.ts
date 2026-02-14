/**
 * SQLite repository for prompt dispatch logging.
 *
 * Stores every outbound prompt payload (redacted) plus token and risk metadata
 * for debugging, forensic analysis, and prompt injection triage.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';

export type PromptDispatchKind =
  | 'chat'
  | 'summary'
  | 'worker_planner'
  | 'worker_executor'
  | 'api_gateway'
  | 'orchestra_routing'
  | 'room';

export type PromptTokensSource = 'exact' | 'estimated';
export type PromptDispatchStatus = 'success' | 'error';
export type PromptDispatchRiskLevel = 'low' | 'medium' | 'high';

export interface PromptDispatchEntry {
  id: string;
  providerId: string;
  modelName: string;
  accountId: string | null;
  dispatchKind: PromptDispatchKind;
  promptTokens: number;
  promptTokensSource: PromptTokensSource;
  completionTokens: number;
  totalTokens: number;
  status: PromptDispatchStatus;
  errorMessage: string | null;
  riskLevel: PromptDispatchRiskLevel;
  riskScore: number;
  riskReasons: string[];
  promptPreview: string;
  promptPayloadJson: string;
  promptCostUsd: number | null;
  completionCostUsd: number | null;
  totalCostUsd: number | null;
  createdAt: string;
}

export interface PromptDispatchFilter {
  from?: string;
  to?: string;
  search?: string;
  provider?: string;
  model?: string;
  risk?: PromptDispatchRiskLevel | 'flagged';
  limit?: number;
  before?: string;
}

export interface PromptDispatchSummary {
  totalEntries: number;
  flaggedEntries: number;
  promptTokensTotal: number;
  promptTokensExactCount: number;
  promptTokensEstimatedCount: number;
}

export interface RecordPromptDispatchInput {
  providerId: string;
  modelName: string;
  accountId: string | null;
  dispatchKind: PromptDispatchKind;
  promptTokens: number;
  promptTokensSource: PromptTokensSource;
  completionTokens: number;
  totalTokens: number;
  status: PromptDispatchStatus;
  errorMessage: string | null;
  riskLevel: PromptDispatchRiskLevel;
  riskScore: number;
  riskReasons: string[];
  promptPreview: string;
  promptPayloadJson: string;
  promptCostUsd?: number | null;
  completionCostUsd?: number | null;
  totalCostUsd?: number | null;
  createdAt?: string;
}

function toPositiveInt(input: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(input || '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function toEntry(row: Record<string, unknown>): PromptDispatchEntry {
  const toNullableNumber = (value: unknown): number | null =>
    value === null || value === undefined ? null : Number(value);

  return {
    id: String(row.id),
    providerId: String(row.provider_id),
    modelName: String(row.model_name),
    accountId: row.account_id ? String(row.account_id) : null,
    dispatchKind: String(row.dispatch_kind) as PromptDispatchKind,
    promptTokens: Number(row.prompt_tokens),
    promptTokensSource: String(row.prompt_tokens_source) as PromptTokensSource,
    completionTokens: Number(row.completion_tokens),
    totalTokens: Number(row.total_tokens),
    status: String(row.status) as PromptDispatchStatus,
    errorMessage: row.error_message ? String(row.error_message) : null,
    riskLevel: String(row.risk_level) as PromptDispatchRiskLevel,
    riskScore: Number(row.risk_score),
    riskReasons: row.risk_reasons_json
      ? (JSON.parse(String(row.risk_reasons_json)) as string[])
      : [],
    promptPreview: String(row.prompt_preview),
    promptPayloadJson: String(row.prompt_payload_json),
    promptCostUsd: toNullableNumber(row.prompt_cost_usd),
    completionCostUsd: toNullableNumber(row.completion_cost_usd),
    totalCostUsd: toNullableNumber(row.total_cost_usd),
    createdAt: String(row.created_at),
  };
}

function buildWhere(filter: PromptDispatchFilter): {
  where: string;
  params: Array<string | number>;
} {
  const conditions: string[] = [];
  const params: Array<string | number> = [];

  if (filter.from) {
    conditions.push('created_at >= ?');
    params.push(filter.from);
  }
  if (filter.to) {
    conditions.push('created_at <= ?');
    params.push(filter.to);
  }
  if (filter.before) {
    conditions.push('created_at < ?');
    params.push(filter.before);
  }
  if (filter.provider) {
    conditions.push('provider_id = ?');
    params.push(filter.provider);
  }
  if (filter.model) {
    conditions.push('model_name = ?');
    params.push(filter.model);
  }
  if (filter.risk) {
    if (filter.risk === 'flagged') {
      conditions.push("risk_level IN ('medium', 'high')");
    } else {
      conditions.push('risk_level = ?');
      params.push(filter.risk);
    }
  }
  if (filter.search) {
    conditions.push(
      "(prompt_preview LIKE ? OR prompt_payload_json LIKE ? OR COALESCE(error_message, '') LIKE ?)",
    );
    const like = `%${filter.search}%`;
    params.push(like, like, like);
  }

  return {
    where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
  };
}

export class PromptDispatchRepository {
  private readonly db: ReturnType<typeof BetterSqlite3>;
  private lastPruneAt = 0;

  constructor(dbPath = process.env.STATS_DB_PATH || '.local/stats.db') {
    if (dbPath === ':memory:') {
      this.db = new BetterSqlite3(':memory:');
    } else {
      const fullPath = path.resolve(dbPath);

      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      this.db = new BetterSqlite3(fullPath);
    }
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS prompt_dispatch_logs (
        id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL,
        model_name TEXT NOT NULL,
        account_id TEXT,
        dispatch_kind TEXT NOT NULL,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        prompt_tokens_source TEXT NOT NULL,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        error_message TEXT,
        risk_level TEXT NOT NULL,
        risk_score INTEGER NOT NULL DEFAULT 0,
        risk_reasons_json TEXT NOT NULL DEFAULT '[]',
        prompt_preview TEXT NOT NULL,
        prompt_payload_json TEXT NOT NULL,
        prompt_cost_usd REAL,
        completion_cost_usd REAL,
        total_cost_usd REAL,
        created_at TEXT NOT NULL
      );
    `);

    this.ensureColumnExists('prompt_dispatch_logs', 'prompt_cost_usd', 'REAL');
    this.ensureColumnExists('prompt_dispatch_logs', 'completion_cost_usd', 'REAL');
    this.ensureColumnExists('prompt_dispatch_logs', 'total_cost_usd', 'REAL');

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_prompt_dispatch_logs_created
        ON prompt_dispatch_logs (created_at DESC);
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_prompt_dispatch_logs_provider
        ON prompt_dispatch_logs (provider_id);
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_prompt_dispatch_logs_model
        ON prompt_dispatch_logs (model_name);
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_prompt_dispatch_logs_risk
        ON prompt_dispatch_logs (risk_level);
    `);
  }

  private ensureColumnExists(table: string, column: string, type: string): void {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<
      Record<string, unknown>
    >;
    const hasColumn = rows.some((row) => String(row.name) === column);
    if (!hasColumn) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }

  recordDispatch(input: RecordPromptDispatchInput): PromptDispatchEntry {
    const id = `pdl-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const createdAt = input.createdAt || new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO prompt_dispatch_logs (
          id, provider_id, model_name, account_id, dispatch_kind,
          prompt_tokens, prompt_tokens_source, completion_tokens, total_tokens,
          status, error_message, risk_level, risk_score, risk_reasons_json,
          prompt_preview, prompt_payload_json, prompt_cost_usd, completion_cost_usd, total_cost_usd, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.providerId,
        input.modelName,
        input.accountId,
        input.dispatchKind,
        input.promptTokens,
        input.promptTokensSource,
        input.completionTokens,
        input.totalTokens,
        input.status,
        input.errorMessage,
        input.riskLevel,
        input.riskScore,
        JSON.stringify(input.riskReasons || []),
        input.promptPreview,
        input.promptPayloadJson,
        input.promptCostUsd ?? null,
        input.completionCostUsd ?? null,
        input.totalCostUsd ?? null,
        createdAt,
      );

    this.maybePrune();

    return {
      id,
      providerId: input.providerId,
      modelName: input.modelName,
      accountId: input.accountId,
      dispatchKind: input.dispatchKind,
      promptTokens: input.promptTokens,
      promptTokensSource: input.promptTokensSource,
      completionTokens: input.completionTokens,
      totalTokens: input.totalTokens,
      status: input.status,
      errorMessage: input.errorMessage,
      riskLevel: input.riskLevel,
      riskScore: input.riskScore,
      riskReasons: input.riskReasons || [],
      promptPreview: input.promptPreview,
      promptPayloadJson: input.promptPayloadJson,
      promptCostUsd: input.promptCostUsd ?? null,
      completionCostUsd: input.completionCostUsd ?? null,
      totalCostUsd: input.totalCostUsd ?? null,
      createdAt,
    };
  }

  listDispatches(filter: PromptDispatchFilter): PromptDispatchEntry[] {
    const { where, params } = buildWhere(filter);
    const limit = filter.limit ?? 100;
    const sql = `SELECT * FROM prompt_dispatch_logs ${where} ORDER BY created_at DESC LIMIT ?`;
    const rows = this.db.prepare(sql).all(...params, limit) as Array<Record<string, unknown>>;
    return rows.map(toEntry);
  }

  countDispatches(filter: PromptDispatchFilter): number {
    const { where, params } = buildWhere(filter);
    const row = this.db
      .prepare(`SELECT COUNT(*) as cnt FROM prompt_dispatch_logs ${where}`)
      .get(...params) as Record<string, unknown>;
    return Number(row.cnt);
  }

  getSummary(filter: PromptDispatchFilter): PromptDispatchSummary {
    const { where, params } = buildWhere(filter);
    const row = this.db
      .prepare(
        `SELECT
          COUNT(*) as total_entries,
          COALESCE(SUM(CASE WHEN risk_level != 'low' THEN 1 ELSE 0 END), 0) as flagged_entries,
          COALESCE(SUM(prompt_tokens), 0) as prompt_tokens_total,
          COALESCE(SUM(CASE WHEN prompt_tokens_source = 'exact' THEN 1 ELSE 0 END), 0) as exact_count,
          COALESCE(SUM(CASE WHEN prompt_tokens_source = 'estimated' THEN 1 ELSE 0 END), 0) as estimated_count
        FROM prompt_dispatch_logs ${where}`,
      )
      .get(...params) as Record<string, unknown>;

    return {
      totalEntries: Number(row.total_entries),
      flaggedEntries: Number(row.flagged_entries),
      promptTokensTotal: Number(row.prompt_tokens_total),
      promptTokensExactCount: Number(row.exact_count),
      promptTokensEstimatedCount: Number(row.estimated_count),
    };
  }

  pruneOldEntries(): void {
    const retentionDays = toPositiveInt(process.env.PROMPT_LOG_RETENTION_DAYS, 30);
    const maxEntries = toPositiveInt(process.env.PROMPT_LOG_MAX_ENTRIES, 10000);

    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    this.db.prepare('DELETE FROM prompt_dispatch_logs WHERE created_at < ?').run(cutoff);

    const countRow = this.db
      .prepare('SELECT COUNT(*) as cnt FROM prompt_dispatch_logs')
      .get() as Record<string, unknown>;
    const count = Number(countRow.cnt);
    if (count <= maxEntries) return;

    const overflow = count - maxEntries;
    this.db
      .prepare(
        `DELETE FROM prompt_dispatch_logs
         WHERE id IN (
           SELECT id FROM prompt_dispatch_logs
           ORDER BY created_at ASC
           LIMIT ?
         )`,
      )
      .run(overflow);
  }

  close(): void {
    this.db.close();
  }

  clearDispatches(): number {
    const result = this.db.prepare('DELETE FROM prompt_dispatch_logs').run() as { changes: number };
    return result.changes;
  }

  private maybePrune(): void {
    const now = Date.now();
    if (now - this.lastPruneAt < 60_000) {
      return;
    }
    this.lastPruneAt = now;
    try {
      this.pruneOldEntries();
    } catch {
      // Never break production flow due to retention cleanup.
    }
  }
}

declare global {
  var __promptDispatchRepository: PromptDispatchRepository | undefined;
}

export function getPromptDispatchRepository(): PromptDispatchRepository {
  if (!globalThis.__promptDispatchRepository) {
    globalThis.__promptDispatchRepository = new PromptDispatchRepository();
  }
  return globalThis.__promptDispatchRepository;
}
