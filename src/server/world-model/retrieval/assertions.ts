import { getWorldModelDb } from '@/server/world-model/db';
import { getWorldModelConfig } from '@/server/world-model/config';

/**
 * Phase 10: Strukturiertes Assertion-Retrieval.
 * Findet aktive Assertions nach Kriterien (Status, Zeit, Subjekt, Text).
 */

export interface AssertionRetrievalHit {
  id: string;
  subjectName: string;
  predicate: string;
  objectValue: string | null;
  modality: string;
  status: string;
  confidence: number;
  knownFrom: string | null;
  knownTo?: string | null;
  validFrom?: string | null;
  sourceObservationId?: string;
}

export interface AssertionRetrievalOptions {
  userId: string;
  personaId: string;
  workspaceId: string;
  query?: string;
  status?: 'active' | 'superseded' | 'retracted';
  knownAsOf?: string; // bitemporal: Wissensstand zu Zeitpunkt
  validAsOf?: string;
  limit?: number;
}

export async function searchAssertions(
  options: AssertionRetrievalOptions,
): Promise<AssertionRetrievalHit[]> {
  const config = getWorldModelConfig();
  if (!config.enabled && !config.e2eEnabled) return [];

  const db = getWorldModelDb();
  const limit = Math.min(50, Math.max(1, options.limit ?? 10));
  const conditions: string[] = ['a.user_id = $1', 'a.persona_id = $2', 'a.workspace_id = $3'];
  const params: unknown[] = [options.userId, options.personaId, options.workspaceId];
  let paramIndex = 4;

  if (options.status) {
    conditions.push(`a.status = $${paramIndex++}`);
    params.push(options.status);
  } else {
    conditions.push(`a.status = 'active'`);
  }

  if (options.knownAsOf) {
    // Bitemporal: nur Assertions, deren known_from <= as_of UND known_to IS NULL oder > as_of.
    const knownAsOfParam = `$${paramIndex++}`;
    conditions.push(`a.known_from <= ${knownAsOfParam}`);
    params.push(options.knownAsOf);
    conditions.push(`(a.known_to IS NULL OR a.known_to > ${knownAsOfParam})`);
  } else {
    conditions.push('a.known_to IS NULL');
  }
  if (options.validAsOf) {
    const validAsOfParam = `$${paramIndex++}`;
    conditions.push(`a.valid_from <= ${validAsOfParam}`);
    params.push(options.validAsOf);
    conditions.push(`(a.valid_to IS NULL OR a.valid_to > ${validAsOfParam})`);
  }

  if (options.query) {
    const like = `%${options.query.toLowerCase()}%`;
    const queryParam = `$${paramIndex++}`;
    conditions.push(`(
      LOWER(e.canonical_name) LIKE ${queryParam}
      OR LOWER(a.object_value) LIKE ${queryParam}
      OR LOWER(a.predicate) LIKE ${queryParam}
    )`);
    params.push(like);
  }

  const limitParam = `$${paramIndex}`;
  params.push(limit);
  const result = await db.query<{
    id: string;
    subject_name: string;
    predicate: string;
    object_value: string | null;
    modality: string;
    status: string;
    confidence: number;
    known_from: string | null;
    known_to: string | null;
    valid_from: string | null;
    source_observation_id: string | null;
  }>(
    `SELECT a.id, e.canonical_name AS subject_name, a.predicate, a.object_value,
            a.modality, a.status, a.confidence, a.known_from, a.known_to,
            a.valid_from, a.source_observation_id
     FROM world_model_assertions a
     JOIN world_model_entities e ON e.id = a.subject_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY a.confidence DESC
     LIMIT ${limitParam}`,
    params,
  );

  return result.rows.map((row) => ({
    id: row.id,
    subjectName: row.subject_name,
    predicate: row.predicate,
    objectValue: row.object_value,
    modality: row.modality,
    status: row.status,
    confidence: row.confidence,
    knownFrom: row.known_from,
    knownTo: row.known_to,
    validFrom: row.valid_from,
    sourceObservationId: row.source_observation_id ?? undefined,
  }));
}
