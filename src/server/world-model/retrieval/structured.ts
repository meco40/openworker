import { getWorldModelDb, type WorldModelQueryExecutor } from '@/server/world-model/db';
import { listEventTimeline } from '@/server/world-model/repositories/eventRepository';
import type { EventStatus } from '@/server/world-model/types';
import type { TimeWindow } from '@/server/world-model/retrieval/queryPlanner';

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

export interface FindStructuredEventsOptions {
  userId: string;
  personaId: string;
  workspaceId: string;
  term: string;
  limit?: number;
  timeWindow?: TimeWindow;
  statusFilter?: EventStatus[];
  validAsOf?: string;
  knownAsOf?: string;
}

/**
 * Phase 3/10 (Retrieval): strukturierte Zustandsabfrage hat Vorrang vor
 * semantischer Aehnlichkeit. Liefert kanonische Zuende (Status + Historie)
 * zu einem passenden Titel-Begriff. Unterstuetzt Zeitfenster und Statusfilter.
 */
export async function findStructuredEvents(
  userIdOrOptions: string | FindStructuredEventsOptions,
  personaIdOrDb?: string | WorldModelQueryExecutor,
  workspaceId?: string,
  term?: string,
  limit = 5,
  dbOrTimeWindow?: WorldModelQueryExecutor | TimeWindow,
  statusFilter?: EventStatus[],
): Promise<StructuredEventHit[]> {
  let opts: FindStructuredEventsOptions;
  let db: WorldModelQueryExecutor;
  if (typeof userIdOrOptions === 'object') {
    opts = userIdOrOptions;
    db = (personaIdOrDb as WorldModelQueryExecutor | undefined) ?? getWorldModelDb();
  } else {
    opts = {
      userId: userIdOrOptions,
      personaId: personaIdOrDb as string,
      workspaceId: workspaceId as string,
      term: term as string,
      limit,
    };
    db = (dbOrTimeWindow as WorldModelQueryExecutor | undefined) ?? getWorldModelDb();
  }

  const { userId, personaId, workspaceId: wsId, term: t, timeWindow, statusFilter: sf } = opts;
  const trimmed = String(t ?? '').trim();
  if (!trimmed) return [];

  const conditions = [
    'user_id = $1',
    'persona_id = $2',
    'workspace_id = $3',
    "title ILIKE ('%' || $4 || '%')",
  ];
  const params: unknown[] = [userId, personaId, wsId, trimmed];
  let idx = 5;

  if (timeWindow?.after) {
    conditions.push(`(scheduled_for >= $${idx++} OR ends_at >= $${idx++})`);
    params.push(timeWindow.after, timeWindow.after);
  }
  if (timeWindow?.before) {
    conditions.push(`(scheduled_for <= $${idx++} OR scheduled_for IS NULL)`);
    params.push(timeWindow.before);
  }
  if (sf?.length) {
    conditions.push(`status = ANY($${idx++})`);
    params.push(sf);
  }
  if (opts.validAsOf) {
    conditions.push(`(scheduled_for IS NULL OR scheduled_for <= $${idx})`);
    params.push(opts.validAsOf);
    idx++;
  }
  if (opts.knownAsOf) {
    conditions.push(`created_at <= $${idx++}`);
    params.push(opts.knownAsOf);
  }
  params.push(opts.limit ?? 5);

  const rows = await db.query<EventRow>(
    `SELECT id, title, status, scheduled_for, ends_at
     FROM world_model_events
     WHERE ${conditions.join(' AND ')}
     ORDER BY updated_at DESC
     LIMIT $${idx}`,
    params,
  );

  const hits: StructuredEventHit[] = [];
  for (const row of rows.rows) {
    const timeline = await listEventTimeline(row.id, db);
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
