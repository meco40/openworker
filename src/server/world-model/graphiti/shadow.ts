import { getWorldModelDb } from '@/server/world-model/db';
import type { OutboxEvent } from '@/server/world-model/types';

export interface ShadowEdgeInput {
  sourceOutboxEventId: string;
  userId: string;
  personaId: string;
  sourceEntity: string;
  targetEntity?: string;
  relationType: string;
  confidence?: number;
  evidenceObservationId?: string;
  validFrom?: string;
  validTo?: string;
  shadowEpisode?: Record<string, unknown>;
}

/**
 * Graphiti Shadow Mode (Phase 5): legt eine nicht-verbindliche temporale
 * Graphen-Projektion ab, die ausschliesslich aus Outbox-Events gespeist wird.
 * Sie entscheidet nichts und dient nur der Messung.
 */
export async function insertShadowEdge(input: ShadowEdgeInput): Promise<void> {
  const db = getWorldModelDb();
  await db.query(
    `INSERT INTO world_model_graphiti_shadow
      (source_outbox_event_id, user_id, persona_id, source_entity, target_entity, relation_type, confidence,
       evidence_observation_id, valid_from, valid_to, shadow_episode)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (source_outbox_event_id) DO NOTHING`,
    [
      input.sourceOutboxEventId,
      input.userId,
      input.personaId,
      input.sourceEntity,
      input.targetEntity ?? null,
      input.relationType,
      input.confidence ?? 1,
      input.evidenceObservationId ?? null,
      input.validFrom ?? null,
      input.validTo ?? null,
      JSON.stringify(input.shadowEpisode ?? {}),
    ],
  );
}

/**
 * Erzeugt den Outbox-Handler fuer `world.observation.created`. Dadurch wird die
 * Shadow-Projektion aus der transactional Outbox befuellt (kein synchroner
 * Dual-Write neben Graphiti).
 */
export function createGraphitiShadowHandler() {
  return async (event: OutboxEvent): Promise<void> => {
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    const userId = String(payload.userId ?? '');
    const personaId = String(payload.personaId ?? '');
    const text = String(payload.text ?? '');
    const sourceEntity = String(payload.sourceEntity ?? (userId || 'user'));
    const targetEntity = payload.targetEntity
      ? String(payload.targetEntity)
      : text.slice(0, 80) || undefined;
    await insertShadowEdge({
      sourceOutboxEventId: event.id,
      userId,
      personaId,
      sourceEntity,
      targetEntity,
      relationType: String(payload.relationType ?? 'mentions'),
      confidence: typeof payload.confidence === 'number' ? payload.confidence : 1,
      evidenceObservationId: event.aggregateId || undefined,
      shadowEpisode: { eventType: event.eventType, createdAt: event.createdAt },
    });
  };
}

export async function countShadowEdges(userId?: string, personaId?: string): Promise<number> {
  const db = getWorldModelDb();
  const params: string[] = [];
  const conditions: string[] = [];
  if (userId) {
    params.push(userId);
    conditions.push(`user_id = $${params.length}`);
  }
  if (personaId) {
    params.push(personaId);
    conditions.push(`persona_id = $${params.length}`);
  }
  const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
  const result = await db.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM world_model_graphiti_shadow${where}`,
    params,
  );
  return Number(result.rows[0]?.count ?? 0);
}
