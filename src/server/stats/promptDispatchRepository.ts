/**
 * SQLite repository for prompt dispatch logging.
 *
 * Stores every outbound prompt payload (redacted) plus token and risk metadata
 * for debugging, forensic analysis, and prompt injection triage.
 */

import crypto from 'node:crypto';
import type BetterSqlite3 from 'better-sqlite3';
import { openSqliteDatabase } from '@/server/db/sqlite';
import {
  buildWhere,
  toEntry,
  toPositiveInt,
} from '@/server/stats/prompt-dispatch-repository/helpers';
import { migratePromptDispatchRepository } from '@/server/stats/prompt-dispatch-repository/migration';
import type {
  PromptDispatchConversationSummary,
  PromptDispatchEntry,
  PromptDispatchFilter,
  PromptDispatchSummary,
  RecordPromptDispatchInput,
} from '@/server/stats/prompt-dispatch-repository/types';

export type {
  PromptDispatchEntry,
  PromptDispatchFilter,
  PromptDispatchKind,
  PromptDispatchRiskLevel,
  PromptDispatchStatus,
  PromptDispatchSummary,
  PromptTokensSource,
  RecordPromptDispatchInput,
} from '@/server/stats/prompt-dispatch-repository/types';

export class PromptDispatchRepository {
  private readonly db: ReturnType<typeof BetterSqlite3>;
  private lastPruneAt = 0;

  constructor(dbPath = process.env.STATS_DB_PATH || '.local/stats.db') {
    this.db = openSqliteDatabase({ dbPath });
    migratePromptDispatchRepository(this.db);
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

  listConversationSummaries(): PromptDispatchConversationSummary[] {
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
    const orderBy = filter.conversationId
      ? 'ORDER BY turn_seq DESC, created_at DESC'
      : 'ORDER BY created_at DESC';
    const sql = `SELECT * FROM prompt_dispatch_logs ${where} ${orderBy} LIMIT ?`;
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

  clearDispatches(): number {
    const result = this.db.prepare('DELETE FROM prompt_dispatch_logs').run() as { changes: number };
    return result.changes;
  }

  close(): void {
    this.db.close();
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
  // eslint-disable-next-line no-var
  var __promptDispatchRepository: PromptDispatchRepository | undefined;
}

export function getPromptDispatchRepository(): PromptDispatchRepository {
  if (!globalThis.__promptDispatchRepository) {
    globalThis.__promptDispatchRepository = new PromptDispatchRepository();
  }
  return globalThis.__promptDispatchRepository;
}
