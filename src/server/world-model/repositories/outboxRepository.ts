import { getWorldModelDb, type WorldModelQueryExecutor } from '@/server/world-model/db';
import type { OutboxEvent, OutboxEventInput, OutboxStatus } from '@/server/world-model/types';

interface OutboxRow {
  id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  payload: unknown;
  status: OutboxStatus;
  attempts: number;
  error_message: string | null;
  created_at: string;
  dispatched_at: string | null;
  idempotency_key?: string | null;
  correlation_id?: string | null;
  user_id?: string | null;
  persona_id?: string | null;
  workspace_id?: string | null;
  inserted?: boolean;
}

function toOutboxEvent(row: OutboxRow): OutboxEvent {
  return {
    id: row.id,
    eventType: row.event_type,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    status: row.status,
    attempts: row.attempts,
    errorMessage: row.error_message ?? undefined,
    createdAt: row.created_at,
    dispatchedAt: row.dispatched_at ?? undefined,
    idempotencyKey: row.idempotency_key ?? undefined,
    correlationId: row.correlation_id ?? undefined,
    userId: row.user_id ?? undefined,
    personaId: row.persona_id ?? undefined,
    workspaceId: row.workspace_id ?? undefined,
    created: row.inserted,
  };
}

export async function enqueueOutboxEvent(
  input: OutboxEventInput,
  db: WorldModelQueryExecutor = getWorldModelDb(),
): Promise<OutboxEvent> {
  const result = await db.query<OutboxRow>(
    `INSERT INTO world_model_outbox_events
      (event_type, aggregate_type, aggregate_id, payload, idempotency_key, correlation_id,
       user_id, persona_id, workspace_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL
       DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
     RETURNING id, event_type, aggregate_type, aggregate_id, payload, status, attempts,
               error_message, created_at, dispatched_at, idempotency_key, correlation_id,
               user_id, persona_id, workspace_id, (xmax = 0) AS inserted`,
    [
      input.eventType,
      input.aggregateType,
      input.aggregateId,
      JSON.stringify(input.payload ?? {}),
      input.idempotencyKey ?? null,
      input.correlationId ?? null,
      input.userId ?? (input.payload?.userId ? String(input.payload.userId) : null),
      input.personaId ?? (input.payload?.personaId ? String(input.payload.personaId) : null),
      input.workspaceId ?? (input.payload?.workspaceId ? String(input.payload.workspaceId) : ''),
    ],
  );
  return toOutboxEvent(result.rows[0]);
}

export async function listPendingOutboxEvents(limit: number): Promise<OutboxEvent[]> {
  const db = getWorldModelDb();
  const result = await db.query<OutboxRow>(
    `SELECT id, event_type, aggregate_type, aggregate_id, payload, status, attempts,
            error_message, created_at, dispatched_at
     FROM world_model_outbox_events
     WHERE status IN ('pending','failed') AND next_attempt_at <= now()
       AND (locked_until IS NULL OR locked_until <= now())
     ORDER BY created_at ASC LIMIT $1`,
    [limit],
  );
  return result.rows.map(toOutboxEvent);
}

export async function claimPendingOutboxEvents(
  limit: number,
  workerId: string,
  leaseMs = 60_000,
  eventTypes: string[] = [],
): Promise<OutboxEvent[]> {
  const db = getWorldModelDb();
  const result = await db.query<OutboxRow>(
    `WITH candidates AS (
       SELECT id
       FROM world_model_outbox_events
       WHERE status IN ('pending','failed') AND next_attempt_at <= now()
         AND (locked_until IS NULL OR locked_until <= now())
         AND (cardinality($4::text[]) = 0 OR event_type = ANY($4::text[]))
       ORDER BY created_at ASC, id ASC
       FOR UPDATE SKIP LOCKED
       LIMIT $1
     )
     UPDATE world_model_outbox_events AS events
     SET locked_by = $2, locked_until = now() + ($3 * interval '1 millisecond')
     FROM candidates
     WHERE events.id = candidates.id
     RETURNING events.id, events.event_type, events.aggregate_type, events.aggregate_id,
               events.payload, events.status, events.attempts, events.error_message,
               events.created_at, events.dispatched_at`,
    [limit, workerId, leaseMs, eventTypes],
  );
  return result.rows.map(toOutboxEvent);
}

export async function markOutboxDispatched(id: string, workerId?: string): Promise<void> {
  const db = getWorldModelDb();
  await db.query(
    `UPDATE world_model_outbox_events SET status = 'dispatched', dispatched_at = now(),
      error_message = NULL, locked_by = NULL, locked_until = NULL
     WHERE id = $1 AND ($2::text IS NULL OR locked_by = $2)`,
    [id, workerId ?? null],
  );
}

export async function markOutboxFailed(
  id: string,
  errorMessage: string,
  workerId?: string,
): Promise<void> {
  const db = getWorldModelDb();
  await db.query(
    `UPDATE world_model_outbox_events SET attempts = attempts + 1, error_message = $2,
       next_attempt_at = now() + (LEAST(300000, 1000 * power(2, attempts + 1)) * interval '1 millisecond'),
       locked_by = NULL, locked_until = NULL,
       status = CASE
         WHEN attempts + 1 >= 5 THEN 'permanent_failure'::world_model_outbox_status
         ELSE 'failed'::world_model_outbox_status
       END
     WHERE id = $1 AND ($3::text IS NULL OR locked_by = $3)`,
    [id, errorMessage.slice(0, 2000), workerId ?? null],
  );
}

export async function resetFailedOutboxEvents(): Promise<number> {
  const db = getWorldModelDb();
  const result = await db.query(
    `UPDATE world_model_outbox_events SET status = 'pending', error_message = NULL,
       next_attempt_at = now(), locked_by = NULL, locked_until = NULL
     WHERE status = 'failed'`,
  );
  return result.rowCount ?? 0;
}
