import { getWorldModelDb, runWithWorldModelScope } from '@/server/world-model/db';
import {
  addGraphitiMessages,
  graphitiGroupId,
  upsertGraphitiNodes,
  upsertGraphitiEdges,
  type GraphitiNode,
  type GraphitiEdge,
  type GraphitiMessage,
} from '@/server/world-model/graphiti/client';
import type { OutboxEvent } from '@/server/world-model/types';

/**
 * Phase 12: Graphiti-Projector.
 *
 * Projiziert ausschließlich aus kanonischen Outbox-Ereignissen in eine
 * Graphiti-Instanz. User, Persona und Workspace werden auf getrennte
 * Graph-Segmente gemappt. Gültige Zeit, ungültige Zeit, Source Observation
 * und Confidence werden übertragen.
 */

export interface ProjectionResult {
  nodesCreated: number;
  nodesUpdated: number;
  edgesCreated: number;
  edgesUpdated: number;
  skipped: number;
}

const SUPPORTED_EVENT_TYPES = new Set([
  'world.observation.created',
  'world.assertion.created',
  'world.event.created',
  'world.relation.created',
]);

function boundedGraphitiText(value: string, maxChars = 1_200): string {
  const limit = Math.max(500, Number(process.env.GRAPHITI_MAX_MESSAGE_CHARS || maxChars));
  return value.length > limit
    ? `${value.slice(0, limit)}\n[content truncated for Graphiti]`
    : value;
}

function observationText(payload: Record<string, unknown>): string {
  const direct = String(payload.text ?? payload.content ?? '').trim();
  if (direct) return direct;
  const texts = Array.isArray(payload.texts) ? payload.texts : [];
  return texts
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return '';
      const item = entry as Record<string, unknown>;
      return String(item.content ?? item.text ?? '').trim();
    })
    .filter(Boolean)
    .join('\n');
}

/**
 * Projiziert ein Outbox-Ereignis in den Graph.
 * Nur unterstützte Ereignistypen werden verarbeitet.
 */
export async function projectOutboxEvent(event: OutboxEvent): Promise<ProjectionResult> {
  if (!SUPPORTED_EVENT_TYPES.has(event.eventType)) {
    return { nodesCreated: 0, nodesUpdated: 0, edgesCreated: 0, edgesUpdated: 0, skipped: 1 };
  }

  const payload = event.payload ?? {};
  const userId = String(payload.userId ?? event.userId ?? '');
  const personaId = String(payload.personaId ?? event.personaId ?? '');
  const workspaceId = String(payload.workspaceId ?? event.workspaceId ?? '');

  if (!userId || !personaId) {
    return { nodesCreated: 0, nodesUpdated: 0, edgesCreated: 0, edgesUpdated: 0, skipped: 1 };
  }

  const segment = graphitiGroupId(userId, personaId, workspaceId);

  try {
    switch (event.eventType) {
      case 'world.observation.created': {
        const text = boundedGraphitiText(observationText(payload));
        if (!text)
          return { nodesCreated: 0, nodesUpdated: 0, edgesCreated: 0, edgesUpdated: 0, skipped: 1 };

        const result = await addGraphitiMessages(segment, [
          {
            uuid: event.aggregateId,
            name: 'world-model-observation',
            content: text,
            roleType: 'system',
            timestamp: event.createdAt,
            sourceDescription: `OpenClaw World Model observation ${event.aggregateId}`,
          },
        ]);
        return {
          nodesCreated: result.accepted,
          nodesUpdated: 0,
          edgesCreated: 0,
          edgesUpdated: 0,
          skipped: 0,
        };
      }

      case 'world.assertion.created': {
        const subject = String(payload.subject ?? '');
        const predicate = String(payload.predicate ?? '');
        const objectValue = String(payload.objectValue ?? '');
        if (!subject || !predicate || !objectValue) {
          return { nodesCreated: 0, nodesUpdated: 0, edgesCreated: 0, edgesUpdated: 0, skipped: 1 };
        }

        const subjectNode: GraphitiNode = {
          id: `ent:${subject}:${segment}`,
          label: subject,
          properties: { segment, category: String(payload.subjectCategory ?? 'person') },
        };
        const objectNode: GraphitiNode = {
          id: `obj:${objectValue}:${segment}`,
          label: objectValue,
          properties: { segment },
        };
        const edge: GraphitiEdge = {
          source: subjectNode.id,
          target: objectNode.id,
          type: predicate,
          properties: {
            segment,
            confidence: payload.confidence,
            validFrom: payload.validFrom,
            sourceObservationId: payload.sourceObservationId,
            eventId: event.id,
          },
        };
        const nodeResult = await upsertGraphitiNodes([subjectNode, objectNode]);
        const edgeResult = await upsertGraphitiEdges([edge]);
        return {
          nodesCreated: nodeResult.created,
          nodesUpdated: nodeResult.updated,
          edgesCreated: edgeResult.created,
          edgesUpdated: edgeResult.updated,
          skipped: 0,
        };
      }

      case 'world.event.created': {
        const title = String(payload.title ?? '');
        const eventType = String(payload.eventType ?? '');
        if (!title)
          return { nodesCreated: 0, nodesUpdated: 0, edgesCreated: 0, edgesUpdated: 0, skipped: 1 };

        const eventDetails = [
          eventType ? `type=${eventType}` : '',
          payload.status ? `status=${String(payload.status)}` : '',
          payload.scheduledFor ? `scheduledFor=${String(payload.scheduledFor)}` : '',
        ]
          .filter(Boolean)
          .join('; ');
        const result = await addGraphitiMessages(segment, [
          {
            uuid: event.aggregateId,
            name: title,
            content: eventDetails ? `${title} (${eventDetails})` : title,
            roleType: 'system',
            timestamp: event.createdAt,
            sourceDescription: `OpenClaw World Model event ${event.aggregateId}`,
          },
        ]);
        return {
          nodesCreated: result.accepted,
          nodesUpdated: 0,
          edgesCreated: 0,
          edgesUpdated: 0,
          skipped: 0,
        };
      }

      case 'world.relation.created': {
        const source = String(payload.sourceEntity ?? '');
        const target = String(payload.targetEntity ?? '');
        const relationType = String(payload.relationType ?? '');
        if (!source || !target || !relationType) {
          return { nodesCreated: 0, nodesUpdated: 0, edgesCreated: 0, edgesUpdated: 0, skipped: 1 };
        }

        const sourceNode: GraphitiNode = {
          id: `ent:${source}:${segment}`,
          label: source,
          properties: { segment },
        };
        const targetNode: GraphitiNode = {
          id: `ent:${target}:${segment}`,
          label: target,
          properties: { segment },
        };
        const edge: GraphitiEdge = {
          source: sourceNode.id,
          target: targetNode.id,
          type: relationType,
          properties: {
            segment,
            confidence: payload.confidence,
            validFrom: payload.validFrom,
            eventId: event.id,
          },
        };
        const nodeResult = await upsertGraphitiNodes([sourceNode, targetNode]);
        const edgeResult = await upsertGraphitiEdges([edge]);
        return {
          nodesCreated: nodeResult.created,
          nodesUpdated: nodeResult.updated,
          edgesCreated: edgeResult.created,
          edgesUpdated: edgeResult.updated,
          skipped: 0,
        };
      }

      default:
        return { nodesCreated: 0, nodesUpdated: 0, edgesCreated: 0, edgesUpdated: 0, skipped: 1 };
    }
  } catch (error) {
    console.error('[world-model:graphiti] projection failed:', error);
    throw error;
  }
}

/**
 * Registriert einen Outbox-Handler für Graphiti-Projektion.
 */
export function createGraphitiProjectorHandler(): (event: OutboxEvent) => Promise<void> {
  return async (event: OutboxEvent): Promise<void> => {
    await projectOutboxEvent(event);
  };
}

type GraphitiRebuildStage = 'observations' | 'assertions' | 'events' | 'relations';

interface RebuildRow {
  id: string;
  user_id: string;
  persona_id: string;
  workspace_id: string;
  created_at: string;
  payload: Record<string, unknown>;
}

async function getRebuildCheckpoint(
  db: ReturnType<typeof getWorldModelDb>,
  input: { userId: string; personaId: string; workspaceId: string },
  phase: GraphitiRebuildStage,
): Promise<{ lastId: string | null; processedCount: number }> {
  const result = await db.query<{ last_id: string | null; processed_count: number }>(
    `SELECT last_id, processed_count FROM world_model_rebuild_checkpoints
     WHERE projection_type = 'graphiti' AND user_id = $1 AND persona_id = $2
       AND workspace_id = $3 AND phase = $4`,
    [input.userId, input.personaId, input.workspaceId, phase],
  );
  return {
    lastId: result.rows[0]?.last_id ?? null,
    processedCount: Number(result.rows[0]?.processed_count ?? 0),
  };
}

async function saveRebuildCheckpoint(
  db: ReturnType<typeof getWorldModelDb>,
  input: { userId: string; personaId: string; workspaceId: string },
  phase: GraphitiRebuildStage,
  lastId: string,
  processedCount: number,
): Promise<void> {
  await db.query(
    `INSERT INTO world_model_rebuild_checkpoints
      (projection_type, user_id, persona_id, workspace_id, phase, last_id, processed_count)
     VALUES ('graphiti', $1, $2, $3, $4, $5, $6)
     ON CONFLICT (projection_type, user_id, persona_id, workspace_id, phase)
     DO UPDATE SET last_id = EXCLUDED.last_id, processed_count = EXCLUDED.processed_count,
                   updated_at = now()`,
    [input.userId, input.personaId, input.workspaceId, phase, lastId, processedCount],
  );
}

async function resetRebuildCheckpoints(
  db: ReturnType<typeof getWorldModelDb>,
  input: { userId: string; personaId: string; workspaceId: string },
): Promise<void> {
  await db.query(
    `DELETE FROM world_model_rebuild_checkpoints
     WHERE projection_type = 'graphiti' AND user_id = $1 AND persona_id = $2 AND workspace_id = $3`,
    [input.userId, input.personaId, input.workspaceId],
  );
}

function toRebuildEvent(stage: GraphitiRebuildStage, row: RebuildRow): OutboxEvent {
  const payload =
    stage === 'observations'
      ? { text: boundedGraphitiText(observationText(row.payload)), sourceObservationId: row.id }
      : row.payload;
  return {
    id: `rebuild-${stage}-${row.id}`,
    eventType:
      stage === 'observations'
        ? 'world.observation.created'
        : stage === 'assertions'
          ? 'world.assertion.created'
          : stage === 'events'
            ? 'world.event.created'
            : 'world.relation.created',
    aggregateType: stage.slice(0, -1),
    aggregateId: row.id,
    userId: row.user_id,
    personaId: row.persona_id,
    workspaceId: row.workspace_id,
    payload: {
      ...payload,
      userId: row.user_id,
      personaId: row.persona_id,
      workspaceId: row.workspace_id,
    },
    status: 'dispatched',
    attempts: 1,
    createdAt: row.created_at,
  };
}

function toRebuildObservationMessage(row: RebuildRow): GraphitiMessage | null {
  const text = boundedGraphitiText(observationText(row.payload));
  if (!text) return null;
  return {
    name: 'world-model-observation',
    content: text,
    roleType: 'system',
    timestamp: row.created_at,
    sourceDescription: `OpenClaw World Model observation ${row.id}`,
  };
}

/**
 * Rebuilds every Graphiti projection from PostgreSQL using a durable keyset
 * checkpoint. The checkpoint is advanced only after the corresponding remote
 * upsert succeeds, so a restart replays at most one item and remains idempotent.
 */
export function rebuildGraphitiFromPostgres(input: {
  userId: string;
  personaId: string;
  workspaceId: string;
  batchSize?: number;
  resume?: boolean;
  includeObservations?: boolean;
}): Promise<{
  nodesCreated: number;
  edgesCreated: number;
  processedEvents: number;
  byStage: Record<GraphitiRebuildStage, number>;
}> {
  return runWithWorldModelScope(input, () => rebuildGraphitiFromPostgresInScope(input));
}

async function rebuildGraphitiFromPostgresInScope(input: {
  userId: string;
  personaId: string;
  workspaceId: string;
  batchSize?: number;
  resume?: boolean;
  includeObservations?: boolean;
}): Promise<{
  nodesCreated: number;
  edgesCreated: number;
  processedEvents: number;
  byStage: Record<GraphitiRebuildStage, number>;
}> {
  const db = getWorldModelDb();
  const batchSize = Math.max(1, Math.min(1000, input.batchSize ?? 100));
  const result = {
    nodesCreated: 0,
    edgesCreated: 0,
    processedEvents: 0,
    byStage: { observations: 0, assertions: 0, events: 0, relations: 0 } as Record<
      GraphitiRebuildStage,
      number
    >,
  };
  const scope = {
    userId: input.userId,
    personaId: input.personaId,
    workspaceId: input.workspaceId,
  };

  if (!input.resume) await resetRebuildCheckpoints(db, scope);

  const stages: GraphitiRebuildStage[] = input.includeObservations
    ? ['observations', 'assertions', 'events', 'relations']
    : ['assertions', 'events', 'relations'];
  for (const stage of stages) {
    let checkpoint = await getRebuildCheckpoint(db, scope, stage);
    while (true) {
      const afterColumn =
        stage === 'assertions'
          ? 'a.id'
          : stage === 'relations'
            ? 'r.id'
            : stage === 'events'
              ? 'e.id'
              : 'o.id';
      const after = checkpoint.lastId ? ` AND ${afterColumn} > $4` : '';
      const params = checkpoint.lastId
        ? [scope.userId, scope.personaId, scope.workspaceId, checkpoint.lastId, batchSize]
        : [scope.userId, scope.personaId, scope.workspaceId, batchSize];
      const limitParam = checkpoint.lastId ? '$5' : '$4';
      let query: string;
      if (stage === 'observations') {
        query = `SELECT o.id, o.user_id, o.persona_id, o.workspace_id, o.created_at, o.payload
          FROM world_model_observations o
          WHERE o.user_id = $1 AND o.persona_id = $2 AND o.workspace_id = $3${after}
          ORDER BY o.id ASC LIMIT ${limitParam}`;
      } else if (stage === 'assertions') {
        query = `SELECT a.id, a.user_id, a.persona_id, a.workspace_id, a.created_at,
            jsonb_build_object('subject', s.canonical_name, 'subjectCategory', s.category,
              'predicate', a.predicate, 'objectValue', COALESCE(a.object_value, o.canonical_name),
              'confidence', a.confidence, 'validFrom', a.valid_from,
              'sourceObservationId', a.source_observation_id) AS payload
          FROM world_model_assertions a
          JOIN world_model_entities s ON s.id = a.subject_id
          LEFT JOIN world_model_entities o ON o.id = a.object_id
          WHERE a.user_id = $1 AND a.persona_id = $2 AND a.workspace_id = $3${after}
          ORDER BY a.id ASC LIMIT ${limitParam}`;
      } else if (stage === 'events') {
        query = `SELECT e.id, e.user_id, e.persona_id, e.workspace_id, e.created_at,
            jsonb_build_object('title', e.title, 'eventType', e.event_type, 'status', e.status,
              'scheduledFor', e.scheduled_for, 'eventId', e.id) AS payload
          FROM world_model_events e
          WHERE e.user_id = $1 AND e.persona_id = $2 AND e.workspace_id = $3${after}
          ORDER BY e.id ASC LIMIT ${limitParam}`;
      } else {
        query = `SELECT r.id, r.user_id, r.persona_id, r.workspace_id, r.known_from AS created_at,
            jsonb_build_object('sourceEntity', s.canonical_name, 'targetEntity', t.canonical_name,
              'relationType', r.relation_type, 'confidence', r.confidence,
              'validFrom', r.valid_from, 'sourceObservationId', r.source_observation_id) AS payload
          FROM world_model_entity_relations r
          JOIN world_model_entities s ON s.id = r.source_entity_id
          JOIN world_model_entities t ON t.id = r.target_entity_id
          WHERE r.user_id = $1 AND r.persona_id = $2 AND r.workspace_id = $3${after}
          ORDER BY r.id ASC LIMIT ${limitParam}`;
      }

      const rows = await db.query<RebuildRow>(query, params);
      if (rows.rows.length === 0) break;
      if (stage === 'observations') {
        const messages = rows.rows.flatMap((row) => {
          const message = toRebuildObservationMessage(row);
          return message ? [message] : [];
        });
        const accepted = await addGraphitiMessages(
          graphitiGroupId(scope.userId, scope.personaId, scope.workspaceId),
          messages,
        );
        result.nodesCreated += accepted.accepted;
        for (const row of rows.rows) {
          result.processedEvents += 1;
          result.byStage[stage] += 1;
          checkpoint = {
            lastId: row.id,
            processedCount: checkpoint.processedCount + 1,
          };
          await saveRebuildCheckpoint(db, scope, stage, row.id, checkpoint.processedCount);
        }
      } else {
        for (const row of rows.rows) {
          const projection = await projectOutboxEvent(toRebuildEvent(stage, row));
          result.nodesCreated += projection.nodesCreated;
          result.edgesCreated += projection.edgesCreated;
          result.processedEvents += 1;
          result.byStage[stage] += 1;
          checkpoint = {
            lastId: row.id,
            processedCount: checkpoint.processedCount + 1,
          };
          await saveRebuildCheckpoint(db, scope, stage, row.id, checkpoint.processedCount);
        }
      }
      if (rows.rows.length < batchSize) break;
    }
  }

  return result;
}
