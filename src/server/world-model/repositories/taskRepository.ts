import {
  getWorldModelDb,
  withWorldModelTransaction,
  type WorldModelQueryExecutor,
} from '@/server/world-model/db';
import type { TaskStatus } from '@/server/world-model/types';

export interface WorldModelTaskInput {
  userId: string;
  personaId: string;
  workspaceId: string;
  title: string;
  description?: string;
  requester?: string;
  assignee?: string;
  externalTaskId?: string;
  origin?: string;
  status?: TaskStatus;
  dueAt?: string;
  idempotencyKey?: string;
  sourceObservationId?: string;
}

export interface WorldModelTaskRecord {
  id: string;
  userId: string;
  personaId: string;
  workspaceId: string;
  title: string;
  description: string | null;
  externalTaskId: string | null;
  status: TaskStatus;
  dueAt: string | null;
  idempotencyKey: string | null;
  sourceObservationId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface TaskRow {
  id: string;
  user_id: string;
  persona_id: string;
  workspace_id: string;
  title: string;
  description: string | null;
  external_task_id: string | null;
  status: TaskStatus;
  due_at: string | null;
  idempotency_key: string | null;
  source_observation_id: string | null;
  created_at: string;
  updated_at: string;
}

function toTask(row: TaskRow): WorldModelTaskRecord {
  return {
    id: row.id,
    userId: row.user_id,
    personaId: row.persona_id,
    workspaceId: row.workspace_id,
    title: row.title,
    description: row.description,
    externalTaskId: row.external_task_id,
    status: row.status,
    dueAt: row.due_at,
    idempotencyKey: row.idempotency_key,
    sourceObservationId: row.source_observation_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function insertTask(
  input: WorldModelTaskInput,
  db: WorldModelQueryExecutor = getWorldModelDb(),
): Promise<WorldModelTaskRecord> {
  const result = await db.query<TaskRow>(
    `INSERT INTO world_model_tasks
      (user_id, persona_id, workspace_id, title, description, requester, assignee,
      origin, external_task_id, status, due_at, idempotency_key, request_observation_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (user_id, persona_id, workspace_id, idempotency_key)
       WHERE idempotency_key IS NOT NULL DO UPDATE SET
         title = EXCLUDED.title, description = EXCLUDED.description,
         requester = EXCLUDED.requester, assignee = EXCLUDED.assignee,
         external_task_id = COALESCE(EXCLUDED.external_task_id, world_model_tasks.external_task_id),
         updated_at = now()
     RETURNING id, user_id, persona_id, workspace_id, title, description, external_task_id, status, due_at,
               idempotency_key, request_observation_id AS source_observation_id, created_at, updated_at`,
    [
      input.userId,
      input.personaId,
      input.workspaceId ?? '',
      input.title,
      input.description ?? null,
      input.requester ?? input.userId,
      input.assignee ?? input.userId,
      input.origin ?? 'mission_control',
      input.externalTaskId ?? null,
      input.status ?? 'proposed',
      input.dueAt ?? null,
      input.idempotencyKey ?? null,
      input.sourceObservationId ?? null,
    ],
  );
  return toTask(result.rows[0]!);
}

export async function updateTaskStatus(
  id: string,
  status: TaskStatus,
  db: WorldModelQueryExecutor = getWorldModelDb(),
): Promise<void> {
  await db.query(`UPDATE world_model_tasks SET status = $2, updated_at = now() WHERE id = $1`, [
    id,
    status,
  ]);
}

export async function completeTaskWithEvidence(
  id: string,
  input: {
    sourceObservationId: string;
    evidence: Record<string, unknown>;
    result?: string;
  },
  db?: WorldModelQueryExecutor,
): Promise<boolean> {
  const complete = async (client: WorldModelQueryExecutor): Promise<boolean> => {
    const current = await client.query<{ status: TaskStatus }>(
      `SELECT status FROM world_model_tasks WHERE id = $1 FOR UPDATE`,
      [id],
    );
    const fromStatus = current.rows[0]?.status;
    if (!fromStatus || fromStatus === 'completed' || fromStatus === 'cancelled') return false;

    const updated = await client.query<{ id: string }>(
      `UPDATE world_model_tasks
       SET status = 'completed', completion_evidence_id = $2,
           evidence = COALESCE(evidence, '{}'::jsonb) || $3::jsonb,
           result = COALESCE($4, result), updated_at = now()
       WHERE id = $1 AND status NOT IN ('completed', 'cancelled')
       RETURNING id`,
      [id, input.sourceObservationId, JSON.stringify(input.evidence), input.result ?? null],
    );
    if (!updated.rows[0]) return false;

    await client.query(
      `INSERT INTO world_model_task_transitions
        (task_id, from_status, to_status, note, source_observation_id)
       VALUES ($1, $2, 'completed', $3, $4)`,
      [id, fromStatus, 'Completion evidence recorded', input.sourceObservationId],
    );
    return true;
  };

  return db ? complete(db) : withWorldModelTransaction(complete);
}

export async function completeTaskByTitle(
  userId: string,
  personaId: string,
  workspaceId: string,
  title: string,
  input: { sourceObservationId: string; evidence: Record<string, unknown>; result?: string },
  db?: WorldModelQueryExecutor,
): Promise<boolean> {
  const complete = async (client: WorldModelQueryExecutor): Promise<boolean> => {
    const result = await client.query<{ id: string }>(
      `SELECT id FROM world_model_tasks
       WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3
         AND LOWER(title) = LOWER($4) AND status NOT IN ('completed', 'cancelled')
       ORDER BY created_at ASC LIMIT 1 FOR UPDATE`,
      [userId, personaId, workspaceId, title],
    );
    const taskId = result.rows[0]?.id;
    return taskId ? completeTaskWithEvidence(taskId, input, client) : false;
  };
  return db ? complete(db) : withWorldModelTransaction(complete);
}

export async function getTaskById(
  id: string,
  db: WorldModelQueryExecutor = getWorldModelDb(),
): Promise<WorldModelTaskRecord | null> {
  const result = await db.query<TaskRow>(
    `SELECT id, user_id, persona_id, workspace_id, title, description, status, due_at,
            external_task_id, idempotency_key, request_observation_id AS source_observation_id,
            created_at, updated_at
     FROM world_model_tasks WHERE id = $1`,
    [id],
  );
  return result.rows[0] ? toTask(result.rows[0]) : null;
}

export async function getTaskByExternalId(
  externalTaskId: string,
  userId: string,
  personaId: string,
  workspaceId: string,
  db: WorldModelQueryExecutor = getWorldModelDb(),
): Promise<WorldModelTaskRecord | null> {
  const result = await db.query<TaskRow>(
    `SELECT id, user_id, persona_id, workspace_id, title, description, external_task_id, status, due_at,
            idempotency_key, request_observation_id AS source_observation_id, created_at, updated_at
     FROM world_model_tasks
     WHERE external_task_id = $1 AND user_id = $2 AND persona_id = $3 AND workspace_id = $4
     LIMIT 1`,
    [externalTaskId, userId, personaId, workspaceId],
  );
  return result.rows[0] ? toTask(result.rows[0]) : null;
}

export async function updateTaskStatusByExternalId(
  externalTaskId: string,
  userId: string,
  personaId: string,
  workspaceId: string,
  status: TaskStatus,
  db: WorldModelQueryExecutor = getWorldModelDb(),
): Promise<boolean> {
  const result = await db.query<{ id: string }>(
    `WITH current_task AS (
       SELECT id, status
       FROM world_model_tasks
       WHERE external_task_id = $1 AND user_id = $2 AND persona_id = $3 AND workspace_id = $4
       LIMIT 1
       FOR UPDATE
     ), updated_task AS (
       UPDATE world_model_tasks AS task
       SET status = $5, updated_at = now()
       FROM current_task
       WHERE task.id = current_task.id AND task.status IS DISTINCT FROM $5
       RETURNING task.id, current_task.status AS from_status, task.status AS to_status
     ), transition AS (
       INSERT INTO world_model_task_transitions (task_id, from_status, to_status, note)
       SELECT id, from_status, to_status, 'Mission Control status mirror'
       FROM updated_task
       RETURNING task_id
     )
     SELECT id FROM current_task`,
    [externalTaskId, userId, personaId, workspaceId, status],
  );
  return result.rows.length > 0;
}

export async function listActiveTasks(
  userId: string,
  personaId: string,
  workspaceId: string,
  limit = 50,
  db: WorldModelQueryExecutor = getWorldModelDb(),
): Promise<WorldModelTaskRecord[]> {
  const result = await db.query<TaskRow>(
    `SELECT id, user_id, persona_id, workspace_id, title, description, external_task_id, status, due_at,
            idempotency_key, request_observation_id AS source_observation_id, created_at, updated_at
     FROM world_model_tasks
     WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3
       AND status NOT IN ('completed', 'cancelled')
     ORDER BY COALESCE(due_at, created_at) ASC LIMIT $4`,
    [userId, personaId, workspaceId, limit],
  );
  return result.rows.map(toTask);
}
