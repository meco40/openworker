import type { KnowledgeExtractionResult } from '@/server/knowledge/extractor';
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
import { getWorldModelConfig } from '@/server/world-model/config';
import {
  completeTaskWithEvidence,
  insertTask,
} from '@/server/world-model/repositories/taskRepository';
import type { WorldModelScope } from '@/server/world-model/scope';
import { stableDedupKey } from '@/server/world-model/projector/idempotency';
import type { ProjectedEvent, WorldModelProjection } from '@/server/world-model/projector/types';
import {
  applyPlanChangeInTx,
  confirmEventOutcomeInTx,
} from '@/server/world-model/services/eventService';
import {
  classifyEventUtterance,
  pickEventCandidate,
  type EventCandidateHit,
} from '@/server/world-model/services/eventLinker';
import { resolveEntity } from '@/server/world-model/services/entityService';
import {
  findStructuredEvents,
  type StructuredEventHit,
} from '@/server/world-model/retrieval/structured';
import type { EventStatus, Observation, ObservationInput } from '@/server/world-model/types';

export interface ProjectWindowInput {
  scope: WorldModelScope;
  projection: WorldModelProjection;
  observation: ObservationInput;
  /** Originalextraktion, damit Quelltext und isConfirmation pro Event verfuegbar sind. */
  extraction?: KnowledgeExtractionResult;
  completedTaskEvidence?: Array<{
    title: string;
    messageSeq: number;
    evidenceText: string;
    confidence: number;
  }>;
}

export interface ProjectWindowOutput {
  observationId: string;
  entitiesUpserted: number;
  eventsCreated: number;
  openLoopsUpserted: number;
  relationsCreated: number;
  assertionsCreated: number;
}

interface SourceMessageText {
  seq: number;
  role: string;
  content: string;
}

function getSourceTextForEvent(
  event: ProjectedEvent,
  payload: ObservationInput['payload'],
  extraction?: KnowledgeExtractionResult,
): string {
  const texts = payload?.texts as SourceMessageText[] | undefined;
  if (texts && event.sourceMessageSeq) {
    const sourceMsg = texts.find((t) => Number(t.seq) === event.sourceMessageSeq);
    if (sourceMsg?.content) return sourceMsg.content;
  }
  const extracted = extraction?.events.find(
    (e) =>
      (e.sourceSeq?.[0] ?? 0) === event.sourceMessageSeq &&
      (e.subject === event.title || e.eventType === event.eventType),
  );
  if (extracted?.confirmationSignals?.length) {
    return extracted.confirmationSignals.join(' ');
  }
  return extraction?.episode || event.title;
}

function isExtractedConfirmation(
  event: ProjectedEvent,
  extraction?: KnowledgeExtractionResult,
): boolean {
  if (!extraction) return false;
  const extracted = extraction.events.find(
    (e) =>
      (e.sourceSeq?.[0] ?? 0) === event.sourceMessageSeq &&
      (e.subject === event.title || e.eventType === event.eventType),
  );
  return extracted?.isConfirmation ?? false;
}

function titlesMatch(a: string, b: string): boolean {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  return left === right || left.includes(right) || right.includes(left);
}

function isActiveEventStatus(status: EventStatus): boolean {
  return status === 'planned' || status === 'proposed' || status === 'in_progress';
}

function toEventCandidateHit(hit: StructuredEventHit): EventCandidateHit {
  return {
    eventId: hit.id,
    title: hit.title,
    confidence: 1.0,
    status: hit.status,
  };
}

/**
 * Phase 3/4: Schreibt eine ganze Projektion und ihre Outbox-Absichten atomar in
 * einer PostgreSQL-Transaktion. Artefakt-IDs sind deterministisch aus
 * Scope+Quellsequenz+Inhalt abgeleitet -> Replay erzeugt denselben Zustand.
 * Vor dem Einfuegen neuer Events werden Bestaetigungen, Absagen und Aenderungen
 * ueber den eventLinker mit bestehenden Events im Scope verknuepft und in derselben
 * Transaktion ausgefuehrt.
 * Der Ingestion-Checkpoint darf erst nach diesem Commit gesetzt werden.
 */
export async function projectWindow(input: ProjectWindowInput): Promise<ProjectWindowOutput> {
  const { scope, projection, observation, extraction } = input;
  const output: ProjectWindowOutput = {
    observationId: '',
    entitiesUpserted: 0,
    eventsCreated: 0,
    openLoopsUpserted: 0,
    relationsCreated: 0,
    assertionsCreated: 0,
  };

  await withWorldModelTransaction(async (client) => {
    const obsResult = await insertObservationWithResult(observation, client);
    output.observationId = obsResult.observation.id;
    const graphitiConfig = getWorldModelConfig();
    if (
      obsResult.created &&
      (graphitiConfig.graphitiShadowEnabled || graphitiConfig.graphitiBackendEnabled)
    ) {
      await enqueueOutboxEvent(
        {
          eventType: 'world.observation.created',
          aggregateType: 'observation',
          aggregateId: obsResult.observation.id,
          payload: {
            userId: scope.userId,
            personaId: scope.personaId,
            workspaceId: scope.workspaceId ?? '',
            text:
              (observation.payload?.texts as Array<{ content?: string }> | undefined)
                ?.map((message) => String(message.content ?? ''))
                .filter(Boolean)
                .join('\n') ?? '',
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
          properties: { dedupKey: key, aliases: entity.aliases ?? [] },
        },
        client,
      );
      output.entitiesUpserted += 1;
    }

    // Relations (nach Entities).
    for (const relation of projection.relations) {
      const source = await resolveEntity(
        { scope, name: relation.sourceEntity, sourceMessageSeq: relation.sourceMessageSeq },
        client,
      );
      const target = await resolveEntity(
        { scope, name: relation.targetEntity, sourceMessageSeq: relation.sourceMessageSeq },
        client,
      );
      if (!source.entityId || !target.entityId || source.ambiguous || target.ambiguous) continue;
      await insertRelation(
        {
          userId: scope.userId,
          personaId: scope.personaId,
          workspaceId: scope.workspaceId ?? '',
          sourceEntityId: source.entityId,
          targetEntityId: target.entityId,
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
      const resolvedSubject = await resolveEntity(
        {
          scope,
          name: assertion.subject,
          category: 'person',
          sourceMessageSeq: assertion.sourceMessageSeq,
        },
        client,
      );
      let subjectId = resolvedSubject.entityId;
      if (resolvedSubject.ambiguous) continue;
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
      await projectEvent({
        scope,
        event,
        observation: obsResult.observation,
        projection,
        extraction,
        client,
        output,
      });
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

    // Tasks
    for (const task of projection.tasks) {
      const taskKey = stableDedupKey(
        {
          scope,
          sourceMessageSeq: task.sourceMessageSeq,
          kind: 'task',
          content: task.title,
        },
        task.assignee,
      );
      const storedTask = await insertTask(
        {
          userId: scope.userId,
          personaId: scope.personaId,
          workspaceId: scope.workspaceId ?? '',
          title: task.title,
          requester: task.requester,
          assignee: task.assignee,
          status: 'proposed',
          idempotencyKey: taskKey,
          sourceObservationId: obsResult.observation.id,
        },
        client,
      );
      const completion = input.completedTaskEvidence?.find(
        (item) => item.title.trim().toLowerCase() === task.title.trim().toLowerCase(),
      );
      if (completion) {
        await completeTaskWithEvidence(
          storedTask.id,
          {
            sourceObservationId: obsResult.observation.id,
            evidence: {
              messageSeq: completion.messageSeq,
              text: completion.evidenceText,
              confidence: completion.confidence,
            },
            result: completion.evidenceText,
          },
          client,
        );
      }
    }
  });

  return output;
}

interface ProjectEventContext {
  scope: WorldModelScope;
  event: ProjectedEvent;
  observation: Observation;
  projection: WorldModelProjection;
  extraction?: KnowledgeExtractionResult;
  client: WorldModelQueryExecutor;
  output: ProjectWindowOutput;
}

async function projectEvent(context: ProjectEventContext): Promise<void> {
  const { scope, event, observation, projection, extraction, client, output } = context;

  const sourceText = getSourceTextForEvent(event, observation.payload, extraction);
  let kind = classifyEventUtterance(sourceText);
  if (isExtractedConfirmation(event, extraction)) {
    kind = 'outcome_confirmation';
  }
  // When one utterance names the cancelled plan and a distinct replacement
  // event (for example "not cinema, dinner instead"), the old event must not
  // be re-created as a second replacement. The sibling projection carries the
  // replacement and is processed in the same window.
  const hasDistinctSiblingReplacement = projection.events.some(
    (candidate) =>
      candidate !== event &&
      candidate.sourceMessageSeq === event.sourceMessageSeq &&
      !titlesMatch(candidate.title, event.title),
  );
  const eventSentence =
    sourceText
      .split(/[.!?]/)
      .find((sentence) => sentence.toLowerCase().includes(event.title.toLowerCase())) ?? sourceText;
  const sentenceCancelsEvent = /\b(nicht|kein|keine|abgesagt|storniert|fällt aus)\b/i.test(
    eventSentence,
  );
  if (kind === 'change' && hasDistinctSiblingReplacement && sentenceCancelsEvent) {
    kind = 'cancellation';
  }

  const structuredHits = await findStructuredEvents(
    scope.userId,
    scope.personaId,
    scope.workspaceId ?? '',
    event.title,
    5,
    client,
  );
  const candidates = structuredHits.map(toEventCandidateHit);
  const picked = pickEventCandidate(kind, candidates);
  const matchedCandidate =
    picked && isActiveEventStatus(picked.status) && titlesMatch(picked.title, event.title)
      ? picked
      : null;
  let replacementEventId = event.replacesEventId;

  if (matchedCandidate) {
    if (kind === 'outcome_confirmation') {
      await confirmEventOutcomeInTx(
        {
          eventId: matchedCandidate.eventId,
          observation,
          outcome: 'completed',
        },
        client,
      );
      output.eventsCreated += 1;
      return;
    }
    if (kind === 'cancellation') {
      await applyPlanChangeInTx(
        {
          eventId: matchedCandidate.eventId,
          toStatus: 'cancelled',
          observation,
          reason: 'user changed plan',
        },
        client,
      );
      output.eventsCreated += 1;
      return;
    }
    if (kind === 'change') {
      await applyPlanChangeInTx(
        {
          eventId: matchedCandidate.eventId,
          toStatus: 'cancelled',
          observation,
          reason: 'user changed plan; replacement follows',
        },
        client,
      );
      replacementEventId = matchedCandidate.eventId;
    }
    // plan / unknown -> idempotent replay, nothing to insert
    if (kind !== 'change') {
      output.eventsCreated += 1;
      return;
    }
  }

  // No matching active candidate.
  if (kind === 'outcome_confirmation' || kind === 'cancellation') {
    const loopKey = stableDedupKey(
      {
        scope,
        sourceMessageSeq: event.sourceMessageSeq,
        kind: 'open_loop',
        content: `ambiguous:${event.title}:${kind}`,
      },
      'clarification',
    );
    await insertOpenLoop(
      {
        userId: scope.userId,
        personaId: scope.personaId,
        workspaceId: scope.workspaceId ?? '',
        type: 'clarification',
        question: `Welches Event meinst du mit "${event.title}"?`,
        deduplicationKey: loopKey,
      },
      client,
    );
    output.openLoopsUpserted += 1;
    return;
  }

  // plan / change / unknown -> insert as new planned event
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
      replacesEventId: replacementEventId,
    },
    client,
  );
  const existingTransition = await client.query(
    `SELECT 1 FROM world_model_event_transitions
     WHERE event_id = $1 AND source_observation_id = $2 AND to_status = $3 LIMIT 1`,
    [storedEvent.id, observation.id, event.status],
  );
  if (!existingTransition.rows[0]) {
    await insertEventTransition(
      {
        eventId: storedEvent.id,
        toStatus: event.status,
        sourceObservationId: observation.id,
        reason: 'knowledge projection',
        confidence: projection.confidenceSummary?.total
          ? projection.confidenceSummary.confident / projection.confidenceSummary.total
          : 0.5,
      },
      client,
    );
  }
  output.eventsCreated += 1;
}
