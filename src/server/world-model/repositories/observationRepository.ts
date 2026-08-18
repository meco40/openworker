import { getWorldModelDb, type WorldModelQueryExecutor } from '@/server/world-model/db';
import type { Observation, ObservationInput } from '@/server/world-model/types';

interface ObservationRow {
  id: string;
  user_id: string;
  persona_id: string;
  workspace_id: string;
  source_type: Observation['sourceType'];
  source_id: string;
  occurred_at: string;
  received_at: string;
  payload: unknown;
  source_authority: string;
}

export interface ObservationScope {
  userId: string;
  personaId: string;
  workspaceId?: string;
}

function toObservation(row: ObservationRow): Observation {
  return {
    id: row.id,
    userId: row.user_id,
    personaId: row.persona_id,
    workspaceId: row.workspace_id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    occurredAt: row.occurred_at,
    receivedAt: row.received_at,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    sourceAuthority: row.source_authority,
  };
}

export async function insertObservationWithResult(
  input: ObservationInput,
  db: WorldModelQueryExecutor = getWorldModelDb(),
): Promise<{ observation: Observation; created: boolean }> {
  const result = await db.query<ObservationRow>(
    `INSERT INTO world_model_observations
      (user_id, persona_id, workspace_id, source_type, source_id, occurred_at, payload, source_authority)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (user_id, persona_id, workspace_id, source_type, source_id) DO NOTHING
     RETURNING id, user_id, persona_id, workspace_id, source_type, source_id,
               occurred_at, received_at, payload, source_authority`,
    [
      input.userId,
      input.personaId,
      input.workspaceId ?? '',
      input.sourceType,
      input.sourceId,
      input.occurredAt,
      JSON.stringify(input.payload ?? {}),
      input.sourceAuthority ?? 'system',
    ],
  );
  if (result.rows[0]) {
    return { observation: toObservation(result.rows[0]), created: true };
  }

  const existing = await db.query<ObservationRow>(
    `SELECT id, user_id, persona_id, workspace_id, source_type, source_id,
            occurred_at, received_at, payload, source_authority
     FROM world_model_observations
     WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3
       AND source_type = $4 AND source_id = $5`,
    [input.userId, input.personaId, input.workspaceId ?? '', input.sourceType, input.sourceId],
  );
  if (!existing.rows[0]) {
    throw new Error('[world-model] observation conflict occurred but existing row was not found');
  }
  return { observation: toObservation(existing.rows[0]), created: false };
}

export async function insertObservation(
  input: ObservationInput,
  db: WorldModelQueryExecutor = getWorldModelDb(),
): Promise<Observation> {
  return (await insertObservationWithResult(input, db)).observation;
}

export async function getObservationById(
  id: string,
  scope?: ObservationScope,
  db: WorldModelQueryExecutor = getWorldModelDb(),
): Promise<Observation | null> {
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
  const result = await db.query<ObservationRow>(
    `SELECT id, user_id, persona_id, workspace_id, source_type, source_id,
            occurred_at, received_at, payload, source_authority
     FROM world_model_observations WHERE ${conditions.join(' AND ')}`,
    values,
  );
  return result.rows[0] ? toObservation(result.rows[0]) : null;
}
