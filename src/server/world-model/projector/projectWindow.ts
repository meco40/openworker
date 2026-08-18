import { withWorldModelTransaction, type WorldModelQueryExecutor } from '@/server/world-model/db';
import { upsertEntity, insertRelation } from '@/server/world-model/repositories/entityRepository';
import {
  insertEvent,
  insertEventTransition,
} from '@/server/world-model/repositories/eventRepository';
import { insertAssertion } from '@/server/world-model/repositories/assertionRepository';
import { insertOpenLoop } from '@/server/world-model/repositories/prospectiveRepository';
import { insertObservationWithResult } from '@/server/world-model/repositories/observationRepository';
import { enqueueOutboxEvent } from '@/server/world-model/repositories/outboxRepository';
import type { WorldModelScope } from '@/server/world-model/scope';
import { stableDedupKey } from '@/server/world-model/projector/idempotency';
import type { WorldModelProjection } from '@/server/world-model/projector/types';
import type { ObservationInput } from '@/server/world-model/types';

export interface ProjectWindowInput {
  scope: WorldModelScope;
  projection: WorldModelProjection;
  observation: ObservationInput;
}

export interface ProjectWindowOutput {
  entitiesUpserted: number;
  eventsCreated: number;
  openLoopsUpserted: number;
  relationsCreated: number;
  assertionsCreated: number;
}

/**
 * Phase 3: Schreibt eine ganze Projektion und ihre Outbox-Absichten atomar in
 * einer PostgreSQL-Transaktion. Artefakt-IDs sind deterministisch aus
 * Scope+Quellsequenz+Inhalt abgeleitet -> Replay erzeugt denselben Zustand.
 * Der Ingestion-Checkpoint darf erst nach diesem Commit gesetzt werden.
 */
export async function projectWindow(input: ProjectWindowInput): Promise<ProjectWindowOutput> {
  const { scope, projection, observation } = input;
  const output: ProjectWindowOutput = {
    entitiesUpserted: 0,
    eventsCreated: 0,
    openLoopsUpserted: 0,
    relationsCreated: 0,
    assertionsCreated: 0,
  };

  if (projection.tasks.length > 0) {
    throw new Error('[world-model:projector] task projection is not implemented');
  }

  await withWorldModelTransaction(async (client) => {
    const obsResult = await insertObservationWithResult(observation, client);
    if (obsResult.created) {
      await enqueueOutboxEvent(
        {
          eventType: 'world.observation.created',
          aggregateType: 'observation',
          aggregateId: obsResult.observation.id,
          payload: {
            userId: scope.userId,
            personaId: scope.personaId,
            workspaceId: scope.workspaceId ?? '',
          },
        },
        client,
      );
    }

    // Entities.
    for (const entity of projection.entities) {
      const key = stableDedupKey(
        {
          scope,
          sourceMessageSeq: entity.sourceMessageSeq,
          kind: 'entity',
          content: entity.canonicalName,
        },
        entity.owner,
      );
      void key;
      await upsertEntity(
        {
          userId: scope.userId,
          personaId: scope.personaId,
          workspaceId: scope.workspaceId ?? '',
          canonicalName: entity.canonicalName,
          category: entity.category,
          owner: entity.owner,
          properties: { dedupKey: key },
        },
        client,
      );
      output.entitiesUpserted += 1;
    }

    // Relations (nach Entities).
    for (const relation of projection.relations) {
      const source = await findEntityInScope(client, scope, relation.sourceEntity);
      const target = await findEntityInScope(client, scope, relation.targetEntity);
      if (!source || !target) continue;
      await insertRelation(
        {
          userId: scope.userId,
          personaId: scope.personaId,
          workspaceId: scope.workspaceId ?? '',
          sourceEntityId: source,
          targetEntityId: target,
          relationType: relation.relationType,
          confidence: relation.confidence,
          sourceObservationId: obsResult.observation.id,
        },
        client,
      );
      output.relationsCreated += 1;
    }

    // Assertions. The normalized subject is resolved as an entity inside the
    // same scope; generic persona facts use the persona entity as subject.
    for (const assertion of projection.assertions) {
      let subjectId = await findEntityInScope(client, scope, assertion.subject);
      if (!subjectId) {
        const subject = await upsertEntity(
          {
            userId: scope.userId,
            personaId: scope.personaId,
            workspaceId: scope.workspaceId ?? '',
            canonicalName: assertion.subject,
            category: 'person',
            owner: 'persona',
          },
          client,
        );
        subjectId = subject.id;
      }
      await insertAssertion(
        {
          userId: scope.userId,
          personaId: scope.personaId,
          workspaceId: scope.workspaceId ?? '',
          subjectId,
          predicate: assertion.predicate,
          objectValue: assertion.objectValue,
          modality: assertion.modality,
          confidence: assertion.confidence,
          sourceObservationId: obsResult.observation.id,
        },
        client,
      );
      output.assertionsCreated += 1;
    }

    // Events + Open Loops.
    for (const event of projection.events) {
      const eventKey = stableDedupKey(
        {
          scope,
          sourceMessageSeq: event.sourceMessageSeq,
          kind: 'event',
          content: `${event.eventType}:${event.title}:${event.scheduledFor ?? ''}`,
        },
        event.status,
      );
      const storedEvent = await insertEvent(
        {
          userId: scope.userId,
          personaId: scope.personaId,
          workspaceId: scope.workspaceId ?? '',
          title: event.title,
          eventType: event.eventType,
          scheduledFor: event.scheduledFor,
          endsAt: event.endsAt,
          status: event.status,
          idempotencyKey: eventKey,
        },
        client,
      );
      const existingTransition = await client.query(
        `SELECT 1 FROM world_model_event_transitions
         WHERE event_id = $1 AND source_observation_id = $2 AND to_status = $3 LIMIT 1`,
        [storedEvent.id, obsResult.observation.id, event.status],
      );
      if (!existingTransition.rows[0]) {
        await insertEventTransition(
          {
            eventId: storedEvent.id,
            toStatus: event.status,
            sourceObservationId: obsResult.observation.id,
            reason: 'knowledge projection',
            confidence: projection.confidenceSummary.total
              ? projection.confidenceSummary.confident / projection.confidenceSummary.total
              : 0.5,
          },
          client,
        );
      }
      output.eventsCreated += 1;
    }
    for (const loop of projection.openLoops) {
      const loopKey = stableDedupKey(
        {
          scope,
          sourceMessageSeq: loop.sourceMessageSeq,
          kind: 'open_loop',
          content: loop.deduplicationKey,
        },
        loop.type,
      );
      await insertOpenLoop(
        {
          userId: scope.userId,
          personaId: scope.personaId,
          workspaceId: scope.workspaceId ?? '',
          type: loop.type,
          question: loop.question,
          deduplicationKey: loopKey,
        },
        client,
      );
      output.openLoopsUpserted += 1;
    }
  });

  return output;
}

async function findEntityInScope(
  client: WorldModelQueryExecutor,
  scope: WorldModelScope,
  name: string,
): Promise<string | null> {
  const res = await client.query<{ id: string }>(
    `SELECT id FROM world_model_entities
     WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3 AND canonical_name = $4 LIMIT 1`,
    [scope.userId, scope.personaId, scope.workspaceId ?? '', name],
  );
  return res.rows[0]?.id ?? null;
}
