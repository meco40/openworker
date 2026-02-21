import crypto from 'node:crypto';
import type BetterSqlite3 from 'better-sqlite3';
import type { RetrievalAuditEntry, InsertRetrievalAuditInput } from '@/server/knowledge/repository';
import { parseJsonObject, asLimit } from './utils';

export class AuditRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  insertRetrievalAudit(input: InsertRetrievalAuditInput): RetrievalAuditEntry {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    this.db
      .prepare(
        `
        INSERT INTO knowledge_retrieval_audit (
          id,
          user_id,
          persona_id,
          conversation_id,
          query_text,
          stage_stats_json,
          token_count,
          had_error,
          error_message,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        id,
        input.userId,
        input.personaId,
        input.conversationId,
        String(input.query || '').trim(),
        JSON.stringify(input.stageStats || {}),
        Math.max(0, Math.floor(Number(input.tokenCount || 0))),
        input.hadError ? 1 : 0,
        input.errorMessage ? String(input.errorMessage).trim() : null,
        now,
      );

    const row = this.db
      .prepare('SELECT * FROM knowledge_retrieval_audit WHERE id = ? LIMIT 1')
      .get(id) as Record<string, unknown>;
    return this.mapAudit(row);
  }

  listRetrievalAudit(filter: {
    userId: string;
    personaId: string;
    limit?: number;
  }): RetrievalAuditEntry[] {
    const limit = asLimit(filter.limit, 25);
    const rows = this.db
      .prepare(
        `
        SELECT *
        FROM knowledge_retrieval_audit
        WHERE user_id = ? AND persona_id = ?
        ORDER BY created_at DESC
        LIMIT ?
      `,
      )
      .all(filter.userId, filter.personaId, limit) as Array<Record<string, unknown>>;

    return rows.map((row) => this.mapAudit(row));
  }

  private mapAudit(row: Record<string, unknown>): RetrievalAuditEntry {
    const stageStatsRaw = parseJsonObject(row.stage_stats_json);
    const stageStats: Record<string, number> = {};
    for (const [key, value] of Object.entries(stageStatsRaw)) {
      const numeric = Number(value);
      if (Number.isFinite(numeric)) {
        stageStats[key] = numeric;
      }
    }

    return {
      id: String(row.id),
      userId: String(row.user_id),
      personaId: String(row.persona_id),
      conversationId: String(row.conversation_id),
      query: String(row.query_text || ''),
      stageStats,
      tokenCount: Number(row.token_count || 0),
      hadError: Number(row.had_error || 0) === 1,
      errorMessage: String(row.error_message || '').trim() || null,
      createdAt: String(row.created_at || ''),
    };
  }
}
