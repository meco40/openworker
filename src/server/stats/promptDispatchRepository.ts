/**
 * SQLite repository for prompt dispatch logging.
 *
 * Stores every outbound prompt payload (redacted) plus token and risk metadata
 * for debugging, forensic analysis, and prompt injection triage.
 */

import crypto from 'node:crypto';
import type BetterSqlite3 from 'better-sqlite3';
import { openSqliteDatabase } from '@/server/db/sqlite';
import type { DebugConversationSummary } from '@/shared/domain/types';

export type PromptDispatchKind =
  | 'chat'
  | 'summary'
  | 'worker_planner'
  | 'worker_executor'
  | 'api_gateway'
  | 'orchestra_routing'
  | 'room'
  | 'knowledge-extraction';

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
  // Conversation linkage
  conversationId: string | null;
  turnSeq: number | null;
  latencyMs: number | null;
  toolCallsJson: string;
  memoryContextJson: string | null;
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
  conversationId?: string;
}

export interface PromptDispatchSummary {
  totalEntries: number;
  flaggedEntries: number;
  promptTokensTotal: number;
  promptTokensExactCount: number;
  promptTokensEstimatedCount: number;
  totalCostUsd: number;
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
  // Conversation linkage
  conversationId?: string | null;
  turnSeq?: number | null;
  latencyMs?: number | null;
  toolCallsJson?: string;
  memoryContextJson?: string | null;
}

function toPositiveInt(input: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(input || '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function toNullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function toEntry(row: Record<string, unknown>): PromptDispatchEntry {
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
    conversationId: row.conversation_id ? String(row.conversation_id) : null,
    turnSeq: row.turn_seq != null ? Number(row.turn_seq) : null,
    latencyMs: row.latency_ms != null ? Number(row.latency_ms) : null,
    toolCallsJson: String(row.tool_calls_json ?? '[]'),
    memoryContextJson: row.memory_context_json ? String(row.memory_context_json) : null,
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
  if (filter.conversationId) {
    conditions.push('conversation_id = ?');
    params.push(filter.conversationId);
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
    this.db = openSqliteDatabase({ dbPath });
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
    this.ensureColumnExists('prompt_dispatch_logs', 'conversation_id', 'TEXT');
    this.ensureColumnExists('prompt_dispatch_logs', 'turn_seq', 'INTEGER');
    this.ensureColumnExists('prompt_dispatch_logs', 'latency_ms', 'INTEGER');
    this.ensureColumnExists(
      'prompt_dispatch_logs',
      'tool_calls_json',
      "TEXT NOT NULL DEFAULT '[]'",
    );
    this.ensureColumnExists('prompt_dispatch_logs', 'memory_context_json', 'TEXT');

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_prompt_dispatch_logs_conversation
        ON prompt_dispatch_logs (conversation_id)
        WHERE conversation_id IS NOT NULL;
    `);

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
          prompt_preview, prompt_payload_json, prompt_cost_usd, completion_cost_usd, total_cost_usd,
          conversation_id, turn_seq, latency_ms, tool_calls_json, memory_context_json,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        input.conversationId ?? null,
        input.turnSeq ?? null,
        input.latencyMs ?? null,
        input.toolCallsJson ?? '[]',
        input.memoryContextJson ?? null,
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
      conversationId: input.conversationId ?? null,
      turnSeq: input.turnSeq ?? null,
      latencyMs: input.latencyMs ?? null,
      toolCallsJson: input.toolCallsJson ?? '[]',
      memoryContextJson: input.memoryContextJson ?? null,
    };
  }

  listConversationSummaries(): DebugConversationSummary[] {
    const rows = this.db
      .prepare(
        `SELECT
          conversation_id,
          COUNT(*) AS turn_count,
          COALESCE(SUM(total_tokens), 0) AS total_tokens,
          COALESCE(SUM(total_cost_usd), 0.0) AS total_cost_usd,
          MAX(created_at) AS last_activity,
          (
            SELECT model_name FROM prompt_dispatch_logs p2
            WHERE p2.conversation_id = p.conversation_id
            ORDER BY created_at DESC LIMIT 1
          ) AS model_name
        FROM prompt_dispatch_logs p
        WHERE conversation_id IS NOT NULL
        GROUP BY conversation_id
        ORDER BY last_activity DESC
        LIMIT 100`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      conversationId: String(row.conversation_id),
      turnCount: Number(row.turn_count),
      totalTokens: Number(row.total_tokens),
      totalCostUsd: row.total_cost_usd != null ? Number(row.total_cost_usd) : null,
      lastActivity: String(row.last_activity),
      modelName: row.model_name ? String(row.model_name) : '',
    }));
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
          COALESCE(SUM(CASE WHEN prompt_tokens_source = 'estimated' THEN 1 ELSE 0 END), 0) as estimated_count,
          COALESCE(SUM(total_cost_usd), 0) as total_cost_usd
        FROM prompt_dispatch_logs ${where}`,
      )
      .get(...params) as Record<string, unknown>;

    return {
      totalEntries: Number(row.total_entries),
      flaggedEntries: Number(row.flagged_entries),
      promptTokensTotal: Number(row.prompt_tokens_total),
      promptTokensExactCount: Number(row.exact_count),
      promptTokensEstimatedCount: Number(row.estimated_count),
      totalCostUsd: Number(row.total_cost_usd),
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
