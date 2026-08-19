import { getWorldModelDb } from '@/server/world-model/db';
import { getWorldModelConfig } from '@/server/world-model/config';

/**
 * Phase 10: Strukturiertes Relations-Retrieval.
 * Findet aktive Beziehungen zwischen Entitäten nach Typ und Zeit.
 */

export interface RelationRetrievalHit {
  id: string;
  sourceEntityName: string;
  targetEntityName: string;
  relationType: string;
  confidence: number;
  validFrom: string | null;
}

export interface RelationRetrievalOptions {
  userId: string;
  personaId: string;
  workspaceId: string;
  relationType?: string;
  entityName?: string;
  validAsOf?: string;
  knownAsOf?: string;
  limit?: number;
}

export async function searchRelations(
  options: RelationRetrievalOptions,
): Promise<RelationRetrievalHit[]> {
  const config = getWorldModelConfig();
  if (!config.enabled && !config.e2eEnabled) return [];

  const db = getWorldModelDb();
  const limit = Math.min(50, Math.max(1, options.limit ?? 10));
  const conditions: string[] = [
    'r.user_id = $1',
    'r.persona_id = $2',
    'r.workspace_id = $3',
    'r.known_to IS NULL',
  ];
  const params: unknown[] = [options.userId, options.personaId, options.workspaceId];
  let idx = 4;

  if (!options.validAsOf) {
    conditions.push('r.valid_to IS NULL');
  }

  if (options.knownAsOf) {
    conditions.push(`r.known_from <= $${idx++}`);
    params.push(options.knownAsOf);
    conditions.push(`(r.known_to IS NULL OR r.known_to > $${idx++})`);
    params.push(options.knownAsOf);
  }

  if (options.relationType) {
    conditions.push(`r.relation_type = $${idx++}`);
    params.push(options.relationType);
  }

  if (options.entityName) {
    const like = `%${options.entityName.toLowerCase()}%`;
    conditions.push(
      `(LOWER(se.canonical_name) LIKE $${idx} OR LOWER(te.canonical_name) LIKE $${idx})`,
    );
    params.push(like);
    idx++;
  }

  if (options.validAsOf) {
    conditions.push(`r.valid_from <= $${idx++}`);
    params.push(options.validAsOf);
    conditions.push(`(r.valid_to IS NULL OR r.valid_to > $${idx++})`);
    params.push(options.validAsOf);
  }

  params.push(limit);
  const result = await db.query<{
    id: string;
    source_entity_name: string;
    target_entity_name: string;
    relation_type: string;
    confidence: number;
    valid_from: string | null;
  }>(
    `SELECT r.id, se.canonical_name AS source_entity_name,
            te.canonical_name AS target_entity_name,
            r.relation_type, r.confidence, r.valid_from
     FROM world_model_entity_relations r
     JOIN world_model_entities se ON se.id = r.source_entity_id
     JOIN world_model_entities te ON te.id = r.target_entity_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY r.confidence DESC
     LIMIT $${idx}`,
    params,
  );

  return result.rows.map((row) => ({
    id: row.id,
    sourceEntityName: row.source_entity_name,
    targetEntityName: row.target_entity_name,
    relationType: row.relation_type,
    confidence: row.confidence,
    validFrom: row.valid_from,
  }));
}
