import type BetterSqlite3 from 'better-sqlite3';
import type {
  SearchMessagesOptions,
  StoredMessage,
} from '@/server/channels/messages/repository/types';
import { toMessage } from '@/server/channels/messages/messageRowMappers';
import { buildFtsQuery } from '@/server/channels/messages/repository/utils/ftsHelpers';
import {
  getChatRecallSlowThresholdMs,
  logChatRecallTrace,
  previewRecallText,
} from '@/server/diagnostics/chatRecallTrace';
import { summarizeError } from '@/server/diagnostics/errorSummary';

export class SearchQueries {
  constructor(private readonly db: BetterSqlite3.Database) {}

  searchMessages(query: string, opts: SearchMessagesOptions = {}): StoredMessage[] {
    const trimmed = query.trim();
    if (!trimmed) return [];

    const limit = Math.max(1, Math.min(200, opts.limit ?? 50));
    const params: (string | number)[] = [];
    const conditions: string[] = [];

    // Build FTS5 match expression — AND all tokens
    const ftsQuery = buildFtsQuery(trimmed);
    if (!ftsQuery) {
      logChatRecallTrace(
        'fts.query_skipped',
        {
          reason: 'no_searchable_tokens',
          queryLength: trimmed.length,
          queryPreview: previewRecallText(trimmed),
          conversationId: opts.conversationId ?? null,
          userId: opts.userId ?? null,
          personaId: opts.personaId ?? null,
          role: opts.role ?? null,
        },
        { force: true, level: 'warn' },
      );
      return [];
    }
    params.push(ftsQuery);

    if (opts.userId) {
      conditions.push('c.user_id = ?');
      params.push(opts.userId);
    }
    if (opts.conversationId) {
      conditions.push('m.conversation_id = ?');
      params.push(opts.conversationId);
    }
    if (opts.personaId) {
      conditions.push('c.persona_id = ?');
      params.push(opts.personaId);
    }
    if (opts.role) {
      conditions.push('m.role = ?');
      params.push(opts.role);
    }

    const whereClause = conditions.length > 0 ? `AND ${conditions.join(' AND ')}` : '';

    const sql = `
      SELECT m.*
      FROM messages_fts fts
      JOIN messages m ON m.rowid = fts.rowid
      JOIN conversations c ON c.id = m.conversation_id
      WHERE messages_fts MATCH ?
      ${whereClause}
      ORDER BY bm25(messages_fts) ASC
      LIMIT ?
    `;
    params.push(limit);
    const startedAt = Date.now();

    try {
      const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
      const durationMs = Date.now() - startedAt;
      const slowThresholdMs = getChatRecallSlowThresholdMs();
      const slow = durationMs >= slowThresholdMs;
      logChatRecallTrace(
        'fts.query_completed',
        {
          durationMs,
          slow,
          slowThresholdMs,
          queryLength: trimmed.length,
          queryPreview: previewRecallText(trimmed),
          ftsQuery,
          resultCount: rows.length,
          limit,
          conversationId: opts.conversationId ?? null,
          userId: opts.userId ?? null,
          personaId: opts.personaId ?? null,
          role: opts.role ?? null,
        },
        { force: slow },
      );
      return rows.map(toMessage);
    } catch (error) {
      logChatRecallTrace(
        'fts.query_failed',
        {
          durationMs: Date.now() - startedAt,
          queryLength: trimmed.length,
          queryPreview: previewRecallText(trimmed),
          ftsQuery,
          limit,
          conversationId: opts.conversationId ?? null,
          userId: opts.userId ?? null,
          personaId: opts.personaId ?? null,
          role: opts.role ?? null,
          error: summarizeError(error),
        },
        { force: true, level: 'error' },
      );
      throw error;
    }
  }
}
