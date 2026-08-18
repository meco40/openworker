import { getWorldModelDb } from '@/server/world-model/db';
import { listEventTimeline } from '@/server/world-model/repositories/eventRepository';
import type { EventStatus } from '@/server/world-model/types';

export interface StructuredEventHit {
  id: string;
  title: string;
  status: EventStatus;
  scheduledFor?: string;
  endsAt?: string;
  timeline: Awaited<ReturnType<typeof listEventTimeline>>;
}

interface EventRow {
  id: string;
  title: string;
  status: EventStatus;
  scheduled_for: string | null;
  ends_at: string | null;
}

/**
 * Phase 3 (Retrieval): strukturierte Zustandsabfrage hat Vorrang vor
 * semantischer Aehnlichkeit. Liefert kanonische Zuende (Status + Historie)
 * zu einem passenden Titel-Begriff.
 */
export async function findStructuredEvents(
  userId: string,
  personaId: string,
  workspaceId: string,
  term: string,
  limit = 5,
): Promise<StructuredEventHit[]> {
  const trimmed = String(term ?? '').trim();
  if (!trimmed) return [];

  const db = getWorldModelDb();
  const rows = await db.query<EventRow>(
    `SELECT id, title, status, scheduled_for, ends_at
     FROM world_model_events
     WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3
       AND title ILIKE ('%' || $4 || '%')
     ORDER BY updated_at DESC
     LIMIT $5`,
    [userId, personaId, workspaceId, trimmed, limit],
  );

  const hits: StructuredEventHit[] = [];
  for (const row of rows.rows) {
    const timeline = await listEventTimeline(row.id);
    hits.push({
      id: row.id,
      title: row.title,
      status: row.status,
      scheduledFor: row.scheduled_for ?? undefined,
      endsAt: row.ends_at ?? undefined,
      timeline,
    });
  }
  return hits;
}
