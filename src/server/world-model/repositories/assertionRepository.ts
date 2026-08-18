import { getWorldModelDb, type WorldModelQueryExecutor } from '@/server/world-model/db';
import type { Modality } from '@/server/world-model/types';

export interface WorldModelAssertionInput {
  userId: string;
  personaId: string;
  workspaceId: string;
  subjectId: string;
  predicate: string;
  objectValue?: string;
  objectId?: string;
  polarity?: 1 | 0 | -1;
  modality?: Modality;
  confidence?: number;
  sourceObservationId?: string;
}

export interface WorldModelAssertionRecord {
  id: string;
  userId: string;
  personaId: string;
  workspaceId: string;
  subjectId: string;
  predicate: string;
  objectValue: string | null;
  modality: Modality;
  status: 'active' | 'superseded' | 'cancelled' | 'retracted';
  confidence: number;
  knownFrom: string;
  knownTo: string | null;
  sourceObservationId: string | null;
  supersedesAssertionId: string | null;
}

interface AssertionRow {
  id: string;
  user_id: string;
  persona_id: string;
  workspace_id: string;
  subject_id: string;
  predicate: string;
  object_value: string | null;
  modality: Modality;
  status: WorldModelAssertionRecord['status'];
  confidence: number;
  known_from: string;
  known_to: string | null;
  source_observation_id: string | null;
  supersedes_assertion_id: string | null;
}

function toAssertion(row: AssertionRow): WorldModelAssertionRecord {
  return {
    id: row.id,
    userId: row.user_id,
    personaId: row.persona_id,
    workspaceId: row.workspace_id,
    subjectId: row.subject_id,
    predicate: row.predicate,
    objectValue: row.object_value,
    modality: row.modality,
    status: row.status,
    confidence: row.confidence,
    knownFrom: row.known_from,
    knownTo: row.known_to,
    sourceObservationId: row.source_observation_id,
    supersedesAssertionId: row.supersedes_assertion_id,
  };
}

const SELECT_COLUMNS = `id, user_id, persona_id, workspace_id, subject_id, predicate,
  object_value, modality, status, confidence, known_from, known_to,
  source_observation_id, supersedes_assertion_id`;

/**
 * Fügt eine neue Assertion hinzu. Beim Anlegen einer neuen Wahrheit wird – falls
 * eine gleichlautende aktive Assertion existiert – deren known_to geschlossen,
 * damit nur eine gleichzeitig aktive Wahrheit gilt. Die alte bleibt als
 * Historien-Evidenz erhalten.
 */
export async function insertAssertion(
  input: WorldModelAssertionInput,
  db: WorldModelQueryExecutor = getWorldModelDb(),
): Promise<WorldModelAssertionRecord> {
  if (input.sourceObservationId) {
    const replay = await db.query<AssertionRow>(
      `SELECT ${SELECT_COLUMNS} FROM world_model_assertions
       WHERE source_observation_id = $1 AND subject_id = $2 AND predicate = $3
         AND object_id IS NOT DISTINCT FROM $4::uuid
         AND object_value IS NOT DISTINCT FROM $5
       LIMIT 1`,
      [
        input.sourceObservationId,
        input.subjectId,
        input.predicate,
        input.objectId ?? null,
        input.objectValue ?? null,
      ],
    );
    if (replay.rows[0]) return toAssertion(replay.rows[0]);
  }
  const now = new Date().toISOString();
  // Alte aktive Wahrheit schliessen (bitemporal: known_to = now).
  const superseded = await db.query<{ id: string }>(
    `UPDATE world_model_assertions
     SET known_to = $4, status = 'superseded'
     WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3
       AND subject_id = $5 AND predicate = $6 AND known_to IS NULL
     RETURNING id`,
    [input.userId, input.personaId, input.workspaceId, now, input.subjectId, input.predicate],
  );

  const res = await db.query<AssertionRow>(
    `INSERT INTO world_model_assertions
      (user_id, persona_id, workspace_id, subject_id, predicate, object_id, object_value,
       polarity, modality, confidence, source_observation_id, supersedes_assertion_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING ${SELECT_COLUMNS}`,
    [
      input.userId,
      input.personaId,
      input.workspaceId,
      input.subjectId,
      input.predicate,
      input.objectId ?? null,
      input.objectValue ?? null,
      input.polarity ?? 1,
      input.modality ?? 'reported',
      input.confidence ?? 0.8,
      input.sourceObservationId ?? null,
      superseded.rows[0]?.id ?? null,
    ],
  );
  return toAssertion(res.rows[0]);
}

export async function listActiveAssertions(
  userId: string,
  personaId: string,
  workspaceId = '',
  db: WorldModelQueryExecutor = getWorldModelDb(),
): Promise<WorldModelAssertionRecord[]> {
  const res = await db.query<AssertionRow>(
    `SELECT ${SELECT_COLUMNS} FROM world_model_assertions
     WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3
       AND status = 'active' AND known_to IS NULL`,
    [userId, personaId, workspaceId],
  );
  return res.rows.map(toAssertion);
}

export async function retractAssertion(
  id: string,
  db: WorldModelQueryExecutor = getWorldModelDb(),
): Promise<void> {
  await db.query(
    `UPDATE world_model_assertions SET status = 'retracted', known_to = now()
     WHERE id = $1 AND status = 'active'`,
    [id],
  );
}

export async function expireAssertion(
  id: string,
  db: WorldModelQueryExecutor = getWorldModelDb(),
): Promise<void> {
  await db.query(
    `UPDATE world_model_assertions SET status = 'cancelled', known_to = now()
     WHERE id = $1 AND status = 'active'`,
    [id],
  );
}
