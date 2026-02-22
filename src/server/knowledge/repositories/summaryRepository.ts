import crypto from 'node:crypto';
import type BetterSqlite3 from 'better-sqlite3';
import type {
  ConversationSummaryEntry,
  UpsertConversationSummaryInput,
} from '@/server/knowledge/repository';
import { parseJsonArray } from './utils';

export class SummaryRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  upsertConversationSummary(input: UpsertConversationSummaryInput): ConversationSummaryEntry {
    const now = new Date().toISOString();
    const id = `csm-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;

    const row = this.db
      .prepare(
        `SELECT id, created_at FROM knowledge_conversation_summaries
         WHERE conversation_id = ? AND persona_id = ?`,
      )
      .get(input.conversationId, input.personaId) as { id: string; created_at: string } | undefined;

    if (row) {
      this.db
        .prepare(
          `UPDATE knowledge_conversation_summaries
           SET summary_text = ?, key_topics_json = ?, entities_json = ?,
               emotional_tone = ?, message_count = ?,
               time_range_start = ?, time_range_end = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          input.summaryText,
          JSON.stringify(input.keyTopics),
          JSON.stringify(input.entitiesMentioned),
          input.emotionalTone,
          input.messageCount,
          input.timeRangeStart,
          input.timeRangeEnd,
          now,
          row.id,
        );

      return {
        id: row.id,
        userId: input.userId,
        personaId: input.personaId,
        conversationId: input.conversationId,
        summaryText: input.summaryText,
        keyTopics: input.keyTopics,
        entitiesMentioned: input.entitiesMentioned,
        emotionalTone: input.emotionalTone,
        messageCount: input.messageCount,
        timeRangeStart: input.timeRangeStart,
        timeRangeEnd: input.timeRangeEnd,
        createdAt: row.created_at,
        updatedAt: now,
      };
    }

    this.db
      .prepare(
        `INSERT INTO knowledge_conversation_summaries
         (id, user_id, persona_id, conversation_id, summary_text,
          key_topics_json, entities_json, emotional_tone, message_count,
          time_range_start, time_range_end, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.userId,
        input.personaId,
        input.conversationId,
        input.summaryText,
        JSON.stringify(input.keyTopics),
        JSON.stringify(input.entitiesMentioned),
        input.emotionalTone,
        input.messageCount,
        input.timeRangeStart,
        input.timeRangeEnd,
        now,
        now,
      );

    return {
      id,
      userId: input.userId,
      personaId: input.personaId,
      conversationId: input.conversationId,
      summaryText: input.summaryText,
      keyTopics: input.keyTopics,
      entitiesMentioned: input.entitiesMentioned,
      emotionalTone: input.emotionalTone,
      messageCount: input.messageCount,
      timeRangeStart: input.timeRangeStart,
      timeRangeEnd: input.timeRangeEnd,
      createdAt: now,
      updatedAt: now,
    };
  }

  listConversationSummaries(filter: {
    userId: string;
    personaId: string;
    conversationId?: string;
    limit?: number;
  }): ConversationSummaryEntry[] {
    const conditions = ['user_id = ?', 'persona_id = ?'];
    const params: unknown[] = [filter.userId, filter.personaId];

    if (filter.conversationId) {
      conditions.push('conversation_id = ?');
      params.push(filter.conversationId);
    }

    const limit = Math.max(1, filter.limit || 50);
    params.push(limit);

    const rows = this.db
      .prepare(
        `SELECT * FROM knowledge_conversation_summaries
         WHERE ${conditions.join(' AND ')}
         ORDER BY updated_at DESC
         LIMIT ?`,
      )
      .all(...params) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: String(row.id),
      userId: String(row.user_id),
      personaId: String(row.persona_id),
      conversationId: String(row.conversation_id),
      summaryText: String(row.summary_text),
      keyTopics: parseJsonArray(row.key_topics_json),
      entitiesMentioned: parseJsonArray(row.entities_json),
      emotionalTone: row.emotional_tone ? String(row.emotional_tone) : null,
      messageCount: Number(row.message_count) || 0,
      timeRangeStart: String(row.time_range_start),
      timeRangeEnd: String(row.time_range_end),
      createdAt: String(row.created_at || ''),
      updatedAt: String(row.updated_at || ''),
    }));
  }
}
