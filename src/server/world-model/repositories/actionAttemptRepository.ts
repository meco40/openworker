import { getWorldModelDb, type WorldModelQueryExecutor } from '@/server/world-model/db';
import type { WorldModelScope } from '@/server/world-model/scope';

export interface ActionAttemptInput {
  scope: WorldModelScope;
  taskId?: string;
  actionType: string;
  idempotencyKey: string;
  correlationId?: string;
}

export interface ActionAttemptRecord {
  id: string;
  taskId: string | null;
  userId: string;
  personaId: string;
  workspaceId: string;
  actionType: string;
  status: 'started' | 'succeeded' | 'failed' | 'aborted';
  idempotencyKey: string;
  correlationId: string | null;
  startedAt: string;
  finishedAt: string | null;
}

interface ActionAttemptRow {
  id: string;
  task_id: string | null;
  user_id: string;
  persona_id: string;
  workspace_id: string;
  action_type: string;
  status: ActionAttemptRecord['status'];
  idempotency_key: string;
  correlation_id: string | null;
  started_at: string;
  finished_at: string | null;
}

function toAttempt(row: ActionAttemptRow): ActionAttemptRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    userId: row.user_id,
    personaId: row.persona_id,
    workspaceId: row.workspace_id,
    actionType: row.action_type,
    status: row.status,
    idempotencyKey: row.idempotency_key,
    correlationId: row.correlation_id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

const SELECT = `id, task_id, user_id, persona_id, workspace_id, action_type, status,
  idempotency_key, correlation_id, started_at, finished_at`;

/**
 * Legt einen idempotenten Action Attempt an. Falls ein Attempt mit demselben
 * idempotencyKey im Scope bereits existiert, wird er zurueckgegeben statt neu
 * angelegt -> gleicher externer Seiteneffekt wird nie unbemerkt doppelt
 * ausgefuehrt.
 */
export async function startActionAttempt(
  input: ActionAttemptInput,
  db: WorldModelQueryExecutor = getWorldModelDb(),
): Promise<{ attempt: ActionAttemptRecord; created: boolean }> {
  const res = await db.query<ActionAttemptRow>(
    `INSERT INTO world_model_action_attempts
      (task_id, user_id, persona_id, workspace_id, action_type, status, idempotency_key, correlation_id)
     VALUES ($1,$2,$3,$4,$5,'started',$6,$7)
     ON CONFLICT (user_id, persona_id, workspace_id, idempotency_key)
       WHERE idempotency_key IS NOT NULL DO NOTHING
     RETURNING ${SELECT}`,
    [
      input.taskId ?? null,
      input.scope.userId,
      input.scope.personaId,
      input.scope.workspaceId ?? '',
      input.actionType,
      input.idempotencyKey,
      input.correlationId ?? null,
    ],
  );
  if (res.rows[0]) return { attempt: toAttempt(res.rows[0]), created: true };

  const existing = await db.query<ActionAttemptRow>(
    `SELECT ${SELECT} FROM world_model_action_attempts
     WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3 AND idempotency_key = $4
     LIMIT 1`,
    [
      input.scope.userId,
      input.scope.personaId,
      input.scope.workspaceId ?? '',
      input.idempotencyKey,
    ],
  );
  if (!existing.rows[0]) {
    throw new Error('[world-model] idempotent action attempt disappeared after conflict');
  }
  return { attempt: toAttempt(existing.rows[0]), created: false };
}

export async function finishActionAttempt(
  id: string,
  status: 'succeeded' | 'failed' | 'aborted',
  db: WorldModelQueryExecutor = getWorldModelDb(),
): Promise<void> {
  await db.query(
    `UPDATE world_model_action_attempts SET status = $2, finished_at = now()
     WHERE id = $1 AND status = 'started'`,
    [id, status],
  );
}
