import { getWorldModelDb, type WorldModelQueryExecutor } from '@/server/world-model/db';
import type { WorldModelScope } from '@/server/world-model/scope';

export interface ProjectionPendingRecord {
  id: string;
  scope: WorldModelScope;
  projectionType: string;
  sourceObservationId: string | null;
  sourceWindowId: string;
  payload: Record<string, unknown>;
  attempts: number;
  status: 'pending' | 'succeeded' | 'failed';
  errorMessage: string | null;
  nextAttemptAt: string;
  createdAt: string;
  updatedAt: string;
}

interface PendingRow {
  id: string;
  user_id: string;
  persona_id: string;
  workspace_id: string;
  projection_type: string;
  source_observation_id: string | null;
  source_window_id: string;
  payload: unknown;
  attempts: number;
  status: ProjectionPendingRecord['status'];
  error_message: string | null;
  next_attempt_at: string;
  created_at: string;
  updated_at: string;
}

function toPending(row: PendingRow): ProjectionPendingRecord {
  return {
    id: row.id,
    scope: {
      userId: row.user_id,
      personaId: row.persona_id,
      workspaceId: row.workspace_id,
    },
    projectionType: row.projection_type,
    sourceObservationId: row.source_observation_id,
    sourceWindowId: row.source_window_id,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    attempts: Number(row.attempts),
    status: row.status,
    errorMessage: row.error_message,
    nextAttemptAt: row.next_attempt_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SELECT = `id, user_id, persona_id, workspace_id, projection_type,
  source_observation_id, source_window_id, payload, attempts, status,
  error_message, next_attempt_at, created_at, updated_at`;

export async function enqueueProjectionPending(
  input: {
    scope: WorldModelScope;
    projectionType: string;
    sourceObservationId?: string | null;
    sourceWindowId: string;
    payload?: Record<string, unknown>;
    errorMessage?: string;
  },
  db: WorldModelQueryExecutor = getWorldModelDb(),
): Promise<ProjectionPendingRecord> {
  const result = await db.query<PendingRow>(
    `INSERT INTO world_model_projection_pending
      (user_id, persona_id, workspace_id, projection_type, source_observation_id,
       source_window_id, payload, error_message)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (user_id, persona_id, workspace_id, projection_type, source_window_id)
       DO UPDATE SET payload = EXCLUDED.payload, error_message = EXCLUDED.error_message,
                     status = 'pending', next_attempt_at = now(), updated_at = now()
     RETURNING ${SELECT}`,
    [
      input.scope.userId,
      input.scope.personaId,
      input.scope.workspaceId ?? '',
      input.projectionType,
      input.sourceObservationId ?? null,
      input.sourceWindowId,
      JSON.stringify(input.payload ?? {}),
      input.errorMessage?.slice(0, 2000) ?? null,
    ],
  );
  return toPending(result.rows[0]!);
}

export async function markProjectionPendingSucceeded(
  id: string,
  db: WorldModelQueryExecutor = getWorldModelDb(),
): Promise<void> {
  await db.query(
    `UPDATE world_model_projection_pending
     SET status = 'succeeded', error_message = NULL, updated_at = now()
     WHERE id = $1`,
    [id],
  );
}

export async function listDueProjectionPending(
  limit = 50,
  db: WorldModelQueryExecutor = getWorldModelDb(),
): Promise<ProjectionPendingRecord[]> {
  const result = await db.query<PendingRow>(
    `SELECT ${SELECT} FROM world_model_projection_pending
     WHERE status IN ('pending','failed') AND next_attempt_at <= now()
     ORDER BY created_at ASC LIMIT $1`,
    [limit],
  );
  return result.rows.map(toPending);
}

export async function markProjectionPendingFailed(
  id: string,
  errorMessage: string,
  db: WorldModelQueryExecutor = getWorldModelDb(),
): Promise<void> {
  await db.query(
    `UPDATE world_model_projection_pending
     SET status = 'failed', attempts = attempts + 1, error_message = $2,
         next_attempt_at = now() + (LEAST(300000, 1000 * power(2, attempts + 1)) * interval '1 millisecond'),
         updated_at = now()
     WHERE id = $1`,
    [id, errorMessage.slice(0, 2000)],
  );
}
