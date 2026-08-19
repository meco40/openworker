import { getWorldModelDb } from '@/server/world-model/db';
import type { Modality } from '@/server/world-model/types';

export interface FullTextHit {
  id: string;
  predicate: string;
  objectValue: string;
  modality: Modality;
  status: string;
  confidence: number;
  sourceObservationId?: string;
  knownFrom?: string;
}

/**
 * PostgreSQL-Volltextsuche ueber aktive Assertions (predicate/object_value). Wird im
 * priorisierten Retrieval nach den strukturierten Zustandsabfragen genutzt.
 */
export async function fullTextSearchAssertions(
  userId: string,
  personaId: string,
  workspaceId: string,
  query: string,
  limit = 10,
  options?: { knownAsOf?: string },
): Promise<FullTextHit[]> {
  const trimmed = String(query ?? '').trim();
  if (!trimmed) return [];

  const db = getWorldModelDb();
  const conditions = [
    'user_id = $1',
    'persona_id = $2',
    'workspace_id = $3',
    "status = 'active'",
    'known_to IS NULL',
    `to_tsvector('simple', concat_ws(' ', predicate, object_value)) @@ plainto_tsquery('simple', $4)`,
  ];
  const params: unknown[] = [userId, personaId, workspaceId, trimmed];
  let limitParam = 5;
  if (options?.knownAsOf) {
    conditions.splice(4, 1, 'known_from <= $5', '(known_to IS NULL OR known_to > $5)');
    params.push(options.knownAsOf);
    limitParam = 6;
  }
  params.push(limit);
  const rows = await db.query<{
    id: string;
    predicate: string;
    object_value: string | null;
    modality: Modality;
    status: string;
    confidence: number;
    source_observation_id: string | null;
    known_from: string;
  }>(
    `SELECT id, predicate, object_value, modality, status, confidence,
            source_observation_id, known_from
     FROM world_model_assertions
     WHERE ${conditions.join(' AND ')}
     ORDER BY confidence DESC, known_from DESC
     LIMIT $${limitParam}`,
    params,
  );

  return rows.rows.map((row) => ({
    id: row.id,
    predicate: row.predicate,
    objectValue: row.object_value ?? '',
    modality: row.modality,
    status: row.status,
    confidence: row.confidence,
    sourceObservationId: row.source_observation_id ?? undefined,
    knownFrom: row.known_from,
  }));
}
