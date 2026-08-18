import {
  getWorldModelDb,
  withWorldModelTransaction,
  type WorldModelQueryExecutor,
} from '@/server/world-model/db';

export interface EntityRecord {
  id: string;
  userId: string;
  personaId: string;
  workspaceId: string;
  canonicalName: string;
  category: string;
  owner: 'persona' | 'user' | 'shared';
  properties: Record<string, unknown>;
  createdAt: string;
}

export interface EntityRelationInput {
  userId: string;
  personaId: string;
  workspaceId: string;
  sourceEntityId: string;
  targetEntityId: string;
  relationType: string;
  confidence?: number;
  validFrom?: string;
  validTo?: string;
  knownFrom?: string;
  sourceObservationId?: string;
}

export interface EntityRelationRecord extends EntityRelationInput {
  id: string;
  direction: 'outgoing' | 'incoming';
  knownTo?: string;
  supersedesRelationId?: string;
}

interface EntityRow {
  id: string;
  user_id: string;
  persona_id: string;
  workspace_id: string;
  canonical_name: string;
  category: string;
  owner: 'persona' | 'user' | 'shared';
  properties: unknown;
  created_at: string;
}

interface RelationRow {
  id: string;
  user_id: string;
  persona_id: string;
  workspace_id: string;
  source_entity_id: string;
  target_entity_id: string;
  relation_type: string;
  direction: 'outgoing' | 'incoming';
  confidence: number;
  valid_from: string;
  valid_to: string | null;
  known_from: string;
  known_to: string | null;
  supersedes_relation_id: string | null;
  source_observation_id: string | null;
}

function toEntity(row: EntityRow): EntityRecord {
  return {
    id: row.id,
    userId: row.user_id,
    personaId: row.persona_id,
    workspaceId: row.workspace_id,
    canonicalName: row.canonical_name,
    category: row.category,
    owner: row.owner,
    properties: (row.properties ?? {}) as Record<string, unknown>,
    createdAt: row.created_at,
  };
}

function toRelation(row: RelationRow): EntityRelationRecord {
  return {
    id: row.id,
    userId: row.user_id,
    personaId: row.persona_id,
    workspaceId: row.workspace_id,
    sourceEntityId: row.source_entity_id,
    targetEntityId: row.target_entity_id,
    relationType: row.relation_type,
    direction: row.direction,
    confidence: row.confidence,
    validFrom: row.valid_from,
    validTo: row.valid_to ?? undefined,
    knownFrom: row.known_from,
    knownTo: row.known_to ?? undefined,
    supersedesRelationId: row.supersedes_relation_id ?? undefined,
    sourceObservationId: row.source_observation_id ?? undefined,
  };
}

export async function upsertEntity(
  input: {
    userId: string;
    personaId: string;
    workspaceId: string;
    canonicalName: string;
    category: string;
    owner?: 'persona' | 'user' | 'shared';
    properties?: Record<string, unknown>;
  },
  db: WorldModelQueryExecutor = getWorldModelDb(),
): Promise<EntityRecord> {
  const result = await db.query<EntityRow>(
    `INSERT INTO world_model_entities
      (user_id, persona_id, workspace_id, canonical_name, category, owner, properties)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (user_id, persona_id, workspace_id, canonical_name, owner) DO UPDATE SET
       properties = CASE WHEN $7::jsonb = '{}'::jsonb THEN world_model_entities.properties
         ELSE world_model_entities.properties || EXCLUDED.properties END,
       updated_at = now()
     RETURNING id, user_id, persona_id, workspace_id, canonical_name, category, owner, properties, created_at`,
    [
      input.userId,
      input.personaId,
      input.workspaceId,
      input.canonicalName,
      input.category,
      input.owner ?? 'shared',
      JSON.stringify(input.properties ?? {}),
    ],
  );
  return toEntity(result.rows[0]);
}

export async function findEntityByName(
  userId: string,
  personaId: string,
  workspaceId: string,
  canonicalName: string,
  db: WorldModelQueryExecutor = getWorldModelDb(),
): Promise<EntityRecord | null> {
  const result = await db.query<EntityRow>(
    `SELECT id, user_id, persona_id, workspace_id, canonical_name, category, owner, properties, created_at
     FROM world_model_entities
     WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3 AND canonical_name = $4
     LIMIT 1`,
    [userId, personaId, workspaceId, canonicalName],
  );
  return result.rows[0] ? toEntity(result.rows[0]) : null;
}

export async function insertRelation(
  input: EntityRelationInput,
  db?: WorldModelQueryExecutor,
): Promise<EntityRelationRecord> {
  const write = async (client: WorldModelQueryExecutor): Promise<EntityRelationRecord> => {
    const entities = await client.query<{ id: string }>(
      `SELECT id FROM world_model_entities
       WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3 AND id = ANY($4::uuid[])`,
      [
        input.userId,
        input.personaId,
        input.workspaceId,
        [input.sourceEntityId, input.targetEntityId],
      ],
    );
    if (entities.rowCount !== 2) {
      throw new Error('[world-model] relation entities must belong to the same user/persona scope');
    }
    if (input.sourceObservationId) {
      const replay = await client.query<RelationRow>(
        `SELECT id, user_id, persona_id, workspace_id, source_entity_id, target_entity_id,
                relation_type, direction, confidence, valid_from, valid_to, known_from, known_to,
                supersedes_relation_id, source_observation_id
         FROM world_model_entity_relations
         WHERE source_observation_id = $1 AND source_entity_id = $2
           AND target_entity_id = $3 AND relation_type = $4
         LIMIT 1`,
        [input.sourceObservationId, input.sourceEntityId, input.targetEntityId, input.relationType],
      );
      if (replay.rows[0]) return toRelation(replay.rows[0]);
    }
    const now = input.knownFrom ?? new Date().toISOString();
    const superseded = await client.query<{ id: string }>(
      `UPDATE world_model_entity_relations SET known_to = $5
       WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3 AND source_entity_id = $4
         AND relation_type = $6 AND known_to IS NULL RETURNING id`,
      [
        input.userId,
        input.personaId,
        input.workspaceId,
        input.sourceEntityId,
        now,
        input.relationType,
      ],
    );
    const result = await client.query<RelationRow>(
      `INSERT INTO world_model_entity_relations
        (user_id, persona_id, workspace_id, source_entity_id, target_entity_id, relation_type,
         confidence, valid_from, valid_to, known_from, supersedes_relation_id, source_observation_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING id, user_id, persona_id, workspace_id, source_entity_id, target_entity_id, relation_type,
                 direction, confidence, valid_from, valid_to, known_from, known_to,
                 supersedes_relation_id, source_observation_id`,
      [
        input.userId,
        input.personaId,
        input.workspaceId,
        input.sourceEntityId,
        input.targetEntityId,
        input.relationType,
        input.confidence ?? 0.8,
        input.validFrom ?? now,
        input.validTo ?? null,
        now,
        superseded.rows[0]?.id ?? null,
        input.sourceObservationId ?? null,
      ],
    );
    return toRelation(result.rows[0]);
  };
  return db ? write(db) : withWorldModelTransaction(write);
}

export async function listActiveRelations(
  userId: string,
  personaId: string,
  workspaceId: string,
  db: WorldModelQueryExecutor = getWorldModelDb(),
): Promise<EntityRelationRecord[]> {
  const result = await db.query<RelationRow>(
    `SELECT id, user_id, persona_id, workspace_id, source_entity_id, target_entity_id, relation_type,
            direction, confidence, valid_from, valid_to, known_from, known_to,
            supersedes_relation_id, source_observation_id
     FROM world_model_entity_relations
     WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3
       AND known_to IS NULL AND valid_to IS NULL
     ORDER BY known_from ASC`,
    [userId, personaId, workspaceId],
  );
  return result.rows.map(toRelation);
}

export async function listRelationHistory(
  userId: string,
  personaId: string,
  workspaceId: string,
  sourceEntityId: string,
  targetEntityId: string,
  relationType: string,
  db: WorldModelQueryExecutor = getWorldModelDb(),
): Promise<EntityRelationRecord[]> {
  const result = await db.query<RelationRow>(
    `SELECT id, user_id, persona_id, workspace_id, source_entity_id, target_entity_id, relation_type,
            direction, confidence, valid_from, valid_to, known_from, known_to,
            supersedes_relation_id, source_observation_id
     FROM world_model_entity_relations
     WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3
       AND source_entity_id = $4 AND target_entity_id = $5 AND relation_type = $6
     ORDER BY known_from ASC`,
    [userId, personaId, workspaceId, sourceEntityId, targetEntityId, relationType],
  );
  return result.rows.map(toRelation);
}
