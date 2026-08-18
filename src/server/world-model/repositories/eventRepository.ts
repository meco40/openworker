import { getWorldModelDb, type WorldModelQueryExecutor } from '@/server/world-model/db';
import type {
  EventRecord,
  EventInput,
  EventStatus,
  EventTransition,
  EventTransitionInput,
} from '@/server/world-model/types';

interface EventRow {
  id: string;
  user_id: string;
  persona_id: string;
  workspace_id: string;
  title: string;
  event_type: string;
  subject_entity_id: string | null;
  counterpart_entity_id: string | null;
  scheduled_for: string | null;
  ends_at: string | null;
  status: EventStatus;
  observed_at: string | null;
  created_at: string;
  updated_at: string;
  idempotency_key?: string | null;
}

interface TransitionRow {
  id: string;
  event_id: string;
  from_status: EventStatus | null;
  to_status: EventStatus;
  reason: string | null;
  source_observation_id: string | null;
  confidence: number;
  transitioned_at: string;
}

function toEvent(row: EventRow): EventRecord {
  return {
    id: row.id,
    userId: row.user_id,
    personaId: row.persona_id,
    workspaceId: row.workspace_id,
    title: row.title,
    eventType: row.event_type,
    subjectEntityId: row.subject_entity_id ?? undefined,
    counterpartEntityId: row.counterpart_entity_id ?? undefined,
    scheduledFor: row.scheduled_for ?? undefined,
    endsAt: row.ends_at ?? undefined,
    status: row.status,
    observedAt: row.observed_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    idempotencyKey: row.idempotency_key ?? undefined,
  };
}

function toTransition(row: TransitionRow): EventTransition {
  return {
    id: row.id,
    eventId: row.event_id,
    fromStatus: row.from_status ?? undefined,
    toStatus: row.to_status,
    reason: row.reason ?? undefined,
    sourceObservationId: row.source_observation_id ?? undefined,
    confidence: row.confidence,
    transitionedAt: row.transitioned_at,
  };
}

export async function insertEvent(
  input: EventInput,
  db: WorldModelQueryExecutor = getWorldModelDb(),
): Promise<EventRecord> {
  const result = await db.query<EventRow>(
    `INSERT INTO world_model_events
      (user_id, persona_id, workspace_id, title, event_type, subject_entity_id,
       counterpart_entity_id, scheduled_for, ends_at, status, observed_at, idempotency_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (user_id, persona_id, workspace_id, idempotency_key)
       WHERE idempotency_key IS NOT NULL DO UPDATE SET updated_at = world_model_events.updated_at
     RETURNING id, user_id, persona_id, workspace_id, title, event_type, subject_entity_id,
               counterpart_entity_id, scheduled_for, ends_at, status, observed_at,
               created_at, updated_at, idempotency_key`,
    [
      input.userId,
      input.personaId,
      input.workspaceId ?? '',
      input.title,
      input.eventType,
      input.subjectEntityId ?? null,
      input.counterpartEntityId ?? null,
      input.scheduledFor ?? null,
      input.endsAt ?? null,
      input.status ?? 'planned',
      input.observedAt ?? null,
      input.idempotencyKey ?? null,
    ],
  );
  return toEvent(result.rows[0]);
}

export async function getEventById(
  id: string,
  scope?: Pick<EventInput, 'userId' | 'personaId' | 'workspaceId'>,
  db: WorldModelQueryExecutor = getWorldModelDb(),
): Promise<EventRecord | null> {
  const conditions = ['id = $1'];
  const values: unknown[] = [id];
  if (scope) {
    values.push(scope.userId, scope.personaId);
    conditions.push(`user_id = $${values.length - 1}`, `persona_id = $${values.length}`);
    if (scope.workspaceId !== undefined) {
      values.push(scope.workspaceId);
      conditions.push(`workspace_id = $${values.length}`);
    }
  }
  const result = await db.query<EventRow>(
    `SELECT id, user_id, persona_id, workspace_id, title, event_type, subject_entity_id,
            counterpart_entity_id, scheduled_for, ends_at, status, observed_at, created_at, updated_at
     FROM world_model_events WHERE ${conditions.join(' AND ')}`,
    values,
  );
  return result.rows[0] ? toEvent(result.rows[0]) : null;
}

export async function updateEventStatus(
  id: string,
  status: EventStatus,
  observedAt?: string,
  db: WorldModelQueryExecutor = getWorldModelDb(),
): Promise<void> {
  await db.query(
    `UPDATE world_model_events SET status = $2, observed_at = COALESCE($3, observed_at), updated_at = now()
     WHERE id = $1`,
    [id, status, observedAt ?? null],
  );
}

export async function insertEventTransition(
  input: EventTransitionInput,
  db: WorldModelQueryExecutor = getWorldModelDb(),
): Promise<EventTransition> {
  const result = await db.query<TransitionRow>(
    `INSERT INTO world_model_event_transitions
      (event_id, from_status, to_status, reason, source_observation_id, confidence, transitioned_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING id, event_id, from_status, to_status, reason, source_observation_id, confidence, transitioned_at`,
    [
      input.eventId,
      input.fromStatus ?? null,
      input.toStatus,
      input.reason ?? null,
      input.sourceObservationId ?? null,
      input.confidence ?? 0.8,
      input.transitionedAt ?? new Date().toISOString(),
    ],
  );
  return toTransition(result.rows[0]);
}

export async function listEventTransitions(
  eventId: string,
  db: WorldModelQueryExecutor = getWorldModelDb(),
): Promise<EventTransition[]> {
  const result = await db.query<TransitionRow>(
    `SELECT id, event_id, from_status, to_status, reason, source_observation_id, confidence, transitioned_at
     FROM world_model_event_transitions WHERE event_id = $1 ORDER BY transitioned_at ASC`,
    [eventId],
  );
  return result.rows.map(toTransition);
}

export interface EventTimelinePoint extends EventTransition {
  title: string;
}

export async function listEventTimeline(
  eventId: string,
  db: WorldModelQueryExecutor = getWorldModelDb(),
): Promise<EventTimelinePoint[]> {
  const result = await db.query<TransitionRow & { title: string }>(
    `SELECT t.id, t.event_id, t.from_status, t.to_status, t.reason, t.source_observation_id,
            t.confidence, t.transitioned_at, e.title
     FROM world_model_event_transitions t JOIN world_model_events e ON e.id = t.event_id
     WHERE t.event_id = $1 ORDER BY t.transitioned_at ASC`,
    [eventId],
  );
  return result.rows.map((row) => ({ ...toTransition(row), title: row.title }));
}
