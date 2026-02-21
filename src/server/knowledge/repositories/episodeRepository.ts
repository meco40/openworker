import crypto from 'node:crypto';
import type BetterSqlite3 from 'better-sqlite3';
import type { KnowledgeEpisode, UpsertKnowledgeEpisodeInput, ListKnowledgeFilter } from '@/server/knowledge/repository';
import { parseJsonArray, parseIso, asLimit, toStringArray, toSourceRefs } from './utils';

export class EpisodeRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  upsertEpisode(input: UpsertKnowledgeEpisodeInput): KnowledgeEpisode {
    const now = new Date().toISOString();
    const sourceSeqStart = Math.max(0, Math.floor(Number(input.sourceSeqStart || 0)));
    const sourceSeqEnd = Math.max(
      sourceSeqStart,
      Math.floor(Number(input.sourceSeqEnd || sourceSeqStart)),
    );

    const existing = this.db
      .prepare(
        `
        SELECT id
        FROM knowledge_episodes
        WHERE conversation_id = ? AND persona_id = ? AND source_seq_start = ? AND source_seq_end = ?
        LIMIT 1
      `,
      )
      .get(input.conversationId, input.personaId, sourceSeqStart, sourceSeqEnd) as
      | { id: string }
      | undefined;

    const id = existing?.id || crypto.randomUUID();

    this.db
      .prepare(
        `
        INSERT INTO knowledge_episodes (
          id,
          user_id,
          persona_id,
          conversation_id,
          topic_key,
          counterpart,
          teaser,
          episode,
          facts_json,
          source_seq_start,
          source_seq_end,
          source_refs_json,
          event_at,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(conversation_id, persona_id, source_seq_start, source_seq_end)
        DO UPDATE SET
          topic_key = excluded.topic_key,
          counterpart = excluded.counterpart,
          teaser = excluded.teaser,
          episode = excluded.episode,
          facts_json = excluded.facts_json,
          source_refs_json = excluded.source_refs_json,
          event_at = excluded.event_at,
          updated_at = excluded.updated_at
      `,
      )
      .run(
        id,
        input.userId,
        input.personaId,
        input.conversationId,
        String(input.topicKey || '').trim() || 'general',
        String(input.counterpart || '').trim() || null,
        String(input.teaser || '').trim(),
        String(input.episode || '').trim(),
        JSON.stringify(toStringArray(input.facts || [])),
        sourceSeqStart,
        sourceSeqEnd,
        JSON.stringify(toSourceRefs(input.sourceRefs || [])),
        parseIso(input.eventAt) || null,
        now,
        now,
      );

    const row = this.db.prepare('SELECT * FROM knowledge_episodes WHERE id = ?').get(id) as Record<
      string,
      unknown
    >;
    return this.mapEpisode(row);
  }

  listEpisodes(filter: ListKnowledgeFilter): KnowledgeEpisode[] {
    const limit = asLimit(filter.limit);
    const conditions: string[] = ['user_id = ?', 'persona_id = ?'];
    const params: Array<string | number> = [filter.userId, filter.personaId];

    if (filter.counterpart?.trim()) {
      conditions.push("LOWER(COALESCE(counterpart, '')) LIKE ?");
      params.push(`%${filter.counterpart.trim().toLowerCase()}%`);
    }
    if (filter.topicKey?.trim()) {
      conditions.push('LOWER(topic_key) LIKE ?');
      params.push(`%${filter.topicKey.trim().toLowerCase()}%`);
    }
    const fromIso = parseIso(filter.from);
    const toIso = parseIso(filter.to);
    if (fromIso) {
      conditions.push('(event_at IS NULL OR event_at >= ?)');
      params.push(fromIso);
    }
    if (toIso) {
      conditions.push('(event_at IS NULL OR event_at <= ?)');
      params.push(toIso);
    }

    const rows = this.db
      .prepare(
        `
        SELECT *
        FROM knowledge_episodes
        WHERE ${conditions.join(' AND ')}
        ORDER BY COALESCE(event_at, updated_at) DESC
        LIMIT ?
      `,
      )
      .all(...params, limit) as Array<Record<string, unknown>>;

    return rows.map((row) => this.mapEpisode(row));
  }

  private mapEpisode(row: Record<string, unknown>): KnowledgeEpisode {
    return {
      id: String(row.id),
      userId: String(row.user_id),
      personaId: String(row.persona_id),
      conversationId: String(row.conversation_id),
      topicKey: String(row.topic_key),
      counterpart: String(row.counterpart || '').trim() || null,
      teaser: String(row.teaser || ''),
      episode: String(row.episode || ''),
      facts: parseJsonArray<string>(row.facts_json),
      sourceSeqStart: Number(row.source_seq_start || 0),
      sourceSeqEnd: Number(row.source_seq_end || 0),
      sourceRefs: parseJsonArray<{ seq: number; quote: string }>(row.source_refs_json),
      eventAt: parseIso(row.event_at),
      updatedAt: String(row.updated_at || ''),
    };
  }
}
