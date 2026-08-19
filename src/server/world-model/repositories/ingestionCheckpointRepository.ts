import { getWorldModelDb, type WorldModelQueryExecutor } from '@/server/world-model/db';

export interface WorldModelIngestionCheckpoint {
  conversationId: string;
  userId: string;
  personaId: string;
  workspaceId: string;
  lastSeq: number;
  sourceWindowId: string;
  committedObservationId: string | null;
  updatedAt: string;
}

interface CheckpointRow {
  conversation_id: string;
  user_id: string;
  persona_id: string;
  workspace_id: string;
  last_seq: number;
  source_window_id: string;
  committed_observation_id: string | null;
  updated_at: string;
}

function toCheckpoint(row: CheckpointRow): WorldModelIngestionCheckpoint {
  return {
    conversationId: row.conversation_id,
    userId: row.user_id,
    personaId: row.persona_id,
    workspaceId: row.workspace_id,
    lastSeq: Number(row.last_seq),
    sourceWindowId: row.source_window_id,
    committedObservationId: row.committed_observation_id,
    updatedAt: row.updated_at,
  };
}

export async function upsertWorldModelIngestionCheckpoint(
  input: {
    conversationId: string;
    userId: string;
    personaId: string;
    workspaceId?: string;
    lastSeq: number;
    sourceWindowId: string;
    committedObservationId?: string | null;
  },
  db: WorldModelQueryExecutor = getWorldModelDb(),
): Promise<WorldModelIngestionCheckpoint> {
  const result = await db.query<CheckpointRow>(
    `INSERT INTO world_model_ingestion_checkpoints
      (conversation_id, user_id, persona_id, workspace_id, last_seq, source_window_id, committed_observation_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (user_id, persona_id, workspace_id, conversation_id) DO UPDATE SET
       last_seq = GREATEST(world_model_ingestion_checkpoints.last_seq, EXCLUDED.last_seq),
       source_window_id = CASE
         WHEN EXCLUDED.last_seq >= world_model_ingestion_checkpoints.last_seq
         THEN EXCLUDED.source_window_id ELSE world_model_ingestion_checkpoints.source_window_id END,
       committed_observation_id = CASE
         WHEN EXCLUDED.last_seq >= world_model_ingestion_checkpoints.last_seq
         THEN EXCLUDED.committed_observation_id ELSE world_model_ingestion_checkpoints.committed_observation_id END,
       updated_at = now()
     RETURNING conversation_id, user_id, persona_id, workspace_id, last_seq,
               source_window_id, committed_observation_id, updated_at`,
    [
      input.conversationId,
      input.userId,
      input.personaId,
      input.workspaceId ?? '',
      Math.max(0, Math.floor(input.lastSeq)),
      input.sourceWindowId,
      input.committedObservationId ?? null,
    ],
  );
  return toCheckpoint(result.rows[0]!);
}

export async function getWorldModelIngestionCheckpoint(
  conversationId: string,
  userId: string,
  personaId: string,
  workspaceId = '',
  db: WorldModelQueryExecutor = getWorldModelDb(),
): Promise<WorldModelIngestionCheckpoint | null> {
  const result = await db.query<CheckpointRow>(
    `SELECT conversation_id, user_id, persona_id, workspace_id, last_seq,
            source_window_id, committed_observation_id, updated_at
     FROM world_model_ingestion_checkpoints
     WHERE conversation_id = $1 AND user_id = $2 AND persona_id = $3 AND workspace_id = $4`,
    [conversationId, userId, personaId, workspaceId],
  );
  return result.rows[0] ? toCheckpoint(result.rows[0]) : null;
}
