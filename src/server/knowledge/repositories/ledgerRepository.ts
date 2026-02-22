import crypto from 'node:crypto';
import type BetterSqlite3 from 'better-sqlite3';
import type {
  MeetingLedgerEntry,
  UpsertMeetingLedgerInput,
  ListKnowledgeFilter,
} from '@/server/knowledge/repository';
import { parseJsonArray, parseIso, asLimit, toStringArray, toSourceRefs } from './utils';

export class LedgerRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  upsertMeetingLedger(input: UpsertMeetingLedgerInput): MeetingLedgerEntry {
    const now = new Date().toISOString();
    const eventAt = parseIso(input.eventAt);

    const existing = this.db
      .prepare(
        `
        SELECT id
        FROM knowledge_meeting_ledger
        WHERE conversation_id = ?
          AND persona_id = ?
          AND topic_key = ?
          AND COALESCE(event_at, '') = COALESCE(?, '')
        LIMIT 1
      `,
      )
      .get(
        input.conversationId,
        input.personaId,
        String(input.topicKey || '').trim() || 'general',
        eventAt,
      ) as { id: string } | undefined;

    const id = existing?.id || crypto.randomUUID();

    this.db
      .prepare(
        `
        INSERT INTO knowledge_meeting_ledger (
          id,
          user_id,
          persona_id,
          conversation_id,
          topic_key,
          counterpart,
          event_at,
          participants_json,
          decisions_json,
          negotiated_terms_json,
          open_points_json,
          action_items_json,
          source_refs_json,
          confidence,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(conversation_id, persona_id, topic_key, event_at)
        DO UPDATE SET
          counterpart = excluded.counterpart,
          participants_json = excluded.participants_json,
          decisions_json = excluded.decisions_json,
          negotiated_terms_json = excluded.negotiated_terms_json,
          open_points_json = excluded.open_points_json,
          action_items_json = excluded.action_items_json,
          source_refs_json = excluded.source_refs_json,
          confidence = excluded.confidence,
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
        eventAt,
        JSON.stringify(toStringArray(input.participants || [])),
        JSON.stringify(toStringArray(input.decisions || [])),
        JSON.stringify(toStringArray(input.negotiatedTerms || [])),
        JSON.stringify(toStringArray(input.openPoints || [])),
        JSON.stringify(toStringArray(input.actionItems || [])),
        JSON.stringify(toSourceRefs(input.sourceRefs || [])),
        Number.isFinite(Number(input.confidence))
          ? Math.max(0, Math.min(1, Number(input.confidence)))
          : 0.5,
        now,
        now,
      );

    const row = this.db
      .prepare('SELECT * FROM knowledge_meeting_ledger WHERE id = ?')
      .get(id) as Record<string, unknown>;
    return this.mapLedger(row);
  }

  listMeetingLedger(filter: ListKnowledgeFilter): MeetingLedgerEntry[] {
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
        FROM knowledge_meeting_ledger
        WHERE ${conditions.join(' AND ')}
        ORDER BY COALESCE(event_at, updated_at) DESC
        LIMIT ?
      `,
      )
      .all(...params, limit) as Array<Record<string, unknown>>;

    return rows.map((row) => this.mapLedger(row));
  }

  private mapLedger(row: Record<string, unknown>): MeetingLedgerEntry {
    return {
      id: String(row.id),
      userId: String(row.user_id),
      personaId: String(row.persona_id),
      conversationId: String(row.conversation_id),
      topicKey: String(row.topic_key),
      counterpart: String(row.counterpart || '').trim() || null,
      eventAt: parseIso(row.event_at),
      participants: parseJsonArray<string>(row.participants_json),
      decisions: parseJsonArray<string>(row.decisions_json),
      negotiatedTerms: parseJsonArray<string>(row.negotiated_terms_json),
      openPoints: parseJsonArray<string>(row.open_points_json),
      actionItems: parseJsonArray<string>(row.action_items_json),
      sourceRefs: parseJsonArray<{ seq: number; quote: string }>(row.source_refs_json),
      confidence: Number(row.confidence || 0),
      updatedAt: String(row.updated_at || ''),
    };
  }
}
