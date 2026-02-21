import type BetterSqlite3 from 'better-sqlite3';
import type { KnowledgeEvent, KnowledgeEventFilter, UpsertKnowledgeEventInput, EventAggregationResult } from '@/server/knowledge/eventTypes';
import { parseJsonArray } from './utils';

export class EventRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  upsertEvent(input: UpsertKnowledgeEventInput): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
        INSERT INTO knowledge_events (
          id, user_id, persona_id, conversation_id,
          event_type, speaker_role, speaker_entity, subject_entity,
          counterpart_entity, relation_label,
          start_date, end_date, day_count,
          source_seq_json, source_summary, is_confirmation, confidence,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, persona_id, event_type, subject_entity, counterpart_entity, start_date, end_date)
        DO UPDATE SET
          speaker_role = excluded.speaker_role,
          speaker_entity = excluded.speaker_entity,
          relation_label = excluded.relation_label,
          source_seq_json = excluded.source_seq_json,
          source_summary = excluded.source_summary,
          is_confirmation = excluded.is_confirmation,
          confidence = excluded.confidence,
          updated_at = excluded.updated_at
      `,
      )
      .run(
        input.id,
        input.userId,
        input.personaId,
        input.conversationId,
        input.eventType,
        input.speakerRole,
        input.speakerEntity,
        input.subjectEntity,
        input.counterpartEntity,
        input.relationLabel ?? null,
        input.startDate,
        input.endDate,
        input.dayCount,
        input.sourceSeqJson ?? '[]',
        input.sourceSummary ?? '',
        input.isConfirmation ? 1 : 0,
        input.confidence ?? 0.8,
        now,
        now,
      );
  }

  appendEventSources(eventId: string, newSeqs: number[], newSummary?: string): void {
    const row = this.db
      .prepare('SELECT source_seq_json, source_summary FROM knowledge_events WHERE id = ?')
      .get(eventId) as { source_seq_json: string; source_summary: string } | undefined;
    if (!row) return;

    const existingSeqs = parseJsonArray<number>(row.source_seq_json);
    const merged = [...new Set([...existingSeqs, ...newSeqs])].sort((a, b) => a - b);
    const summary = newSummary ? `${row.source_summary}\n${newSummary}`.trim() : row.source_summary;

    this.db
      .prepare(
        `UPDATE knowledge_events
         SET source_seq_json = ?, source_summary = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(JSON.stringify(merged), summary, new Date().toISOString(), eventId);
  }

  listEvents(filter: KnowledgeEventFilter, limit = 100): KnowledgeEvent[] {
    const conditions: string[] = ['user_id = ?', 'persona_id = ?'];
    const params: Array<string | number> = [filter.userId, filter.personaId];

    if (filter.eventType) {
      conditions.push('event_type = ?');
      params.push(filter.eventType);
    }
    if (filter.speakerRole) {
      conditions.push('speaker_role = ?');
      params.push(filter.speakerRole);
    }
    if (filter.subjectEntity) {
      conditions.push('LOWER(subject_entity) = ?');
      params.push(filter.subjectEntity.toLowerCase());
    }
    if (filter.counterpartEntity) {
      conditions.push('LOWER(counterpart_entity) = ?');
      params.push(filter.counterpartEntity.toLowerCase());
    }
    if (filter.relationLabel) {
      conditions.push("LOWER(COALESCE(relation_label, '')) = ?");
      params.push(filter.relationLabel.toLowerCase());
    }
    if (filter.from) {
      conditions.push('end_date >= ?');
      params.push(filter.from);
    }
    if (filter.to) {
      conditions.push('start_date <= ?');
      params.push(filter.to);
    }

    const rows = this.db
      .prepare(
        `SELECT * FROM knowledge_events
         WHERE ${conditions.join(' AND ')}
         ORDER BY start_date DESC
         LIMIT ?`,
      )
      .all(...params, limit) as Array<Record<string, unknown>>;

    return rows.map((row) => this.mapEvent(row));
  }

  findOverlappingEvents(filter: KnowledgeEventFilter): KnowledgeEvent[] {
    const conditions: string[] = ['user_id = ?', 'persona_id = ?'];
    const params: Array<string | number> = [filter.userId, filter.personaId];

    if (filter.eventType) {
      conditions.push('event_type = ?');
      params.push(filter.eventType);
    }
    if (filter.speakerRole) {
      conditions.push('speaker_role = ?');
      params.push(filter.speakerRole);
    }
    if (filter.counterpartEntity) {
      conditions.push('LOWER(counterpart_entity) = ?');
      params.push(filter.counterpartEntity.toLowerCase());
    }
    if (filter.from && filter.to) {
      // Overlap: existing.start <= candidate.end AND existing.end >= candidate.start
      conditions.push('start_date <= ? AND end_date >= ?');
      params.push(filter.to, filter.from);
    }

    const rows = this.db
      .prepare(
        `SELECT * FROM knowledge_events
         WHERE ${conditions.join(' AND ')}
         ORDER BY start_date DESC`,
      )
      .all(...params) as Array<Record<string, unknown>>;

    return rows.map((row) => this.mapEvent(row));
  }

  countUniqueDays(filter: KnowledgeEventFilter): EventAggregationResult {
    const events = this.listEvents(filter);
    const daySet = new Set<string>();
    const realEvents: KnowledgeEvent[] = [];

    for (const event of events) {
      if (event.isConfirmation) continue;
      realEvents.push(event);
      const start = new Date(event.startDate + 'T00:00:00Z');
      const end = new Date(event.endDate + 'T00:00:00Z');
      for (const d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
        daySet.add(d.toISOString().slice(0, 10));
      }
    }

    const uniqueDays = [...daySet].sort();
    return {
      uniqueDayCount: uniqueDays.length,
      uniqueDays,
      eventCount: realEvents.length,
      events,
    };
  }

  private mapEvent(row: Record<string, unknown>): KnowledgeEvent {
    return {
      id: String(row.id),
      userId: String(row.user_id),
      personaId: String(row.persona_id),
      conversationId: String(row.conversation_id),
      eventType: String(row.event_type),
      speakerRole: String(row.speaker_role) as 'assistant' | 'user',
      speakerEntity: String(row.speaker_entity),
      subjectEntity: String(row.subject_entity),
      counterpartEntity: String(row.counterpart_entity),
      relationLabel: row.relation_label ? String(row.relation_label) : null,
      startDate: String(row.start_date),
      endDate: String(row.end_date),
      dayCount: Number(row.day_count || 0),
      sourceSeqJson: String(row.source_seq_json || '[]'),
      sourceSummary: String(row.source_summary || ''),
      isConfirmation: Number(row.is_confirmation || 0) === 1,
      confidence: Number(row.confidence || 0),
      createdAt: String(row.created_at || ''),
      updatedAt: String(row.updated_at || ''),
    };
  }
}
