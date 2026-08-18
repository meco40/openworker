import { getWorldModelDb } from '@/server/world-model/db';
import type { Modality } from '@/server/world-model/types';

export interface FullTextHit {
  predicate: string;
  objectValue: string;
  modality: Modality;
  status: string;
  confidence: number;
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
): Promise<FullTextHit[]> {
  const trimmed = String(query ?? '').trim();
  if (!trimmed) return [];

  const db = getWorldModelDb();
  const rows = await db.query<{
    predicate: string;
    object_value: string | null;
    modality: Modality;
    status: string;
    confidence: number;
  }>(
    `SELECT predicate, object_value, modality, status, confidence
     FROM world_model_assertions
     WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3
       AND status = 'active' AND known_to IS NULL
       AND to_tsvector('simple', concat_ws(' ', predicate, object_value))
         @@ plainto_tsquery('simple', $4)
     ORDER BY confidence DESC, known_from DESC
     LIMIT $5`,
    [userId, personaId, workspaceId, trimmed, limit],
  );

  return rows.rows.map((row) => ({
    predicate: row.predicate,
    objectValue: row.object_value ?? '',
    modality: row.modality,
    status: row.status,
    confidence: row.confidence,
  }));
}
