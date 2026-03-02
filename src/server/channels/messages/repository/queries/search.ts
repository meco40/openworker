import type BetterSqlite3 from 'better-sqlite3';
import type {
  SearchMessagesOptions,
  StoredMessage,
} from '@/server/channels/messages/repository/types';
import { toMessage } from '@/server/channels/messages/messageRowMappers';
import { buildFtsQuery } from '@/server/channels/messages/repository/utils/ftsHelpers';

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

    const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    return rows.map(toMessage);
  }
}
