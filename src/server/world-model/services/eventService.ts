import { withWorldModelTransaction, type WorldModelQueryExecutor } from '@/server/world-model/db';
import {
  getEventById,
  insertEvent,
  insertEventTransition,
  listEventTimeline,
  updateEventStatus,
} from '@/server/world-model/repositories/eventRepository';
import { insertObservationWithResult } from '@/server/world-model/repositories/observationRepository';
import { enqueueOutboxEvent } from '@/server/world-model/repositories/outboxRepository';
import {
  getOpenLoopByKey,
  insertOpenLoop,
  updateOpenLoopStatus,
} from '@/server/world-model/repositories/prospectiveRepository';
import type {
  EventRecord,
  EventStatus,
  EventTransition,
  EventTransitionInput,
  ObservationInput,
} from '@/server/world-model/types';

export type PlanChangeResult =
  | {
      kind: EventStatus;
      event: EventRecord;
      transition: Awaited<ReturnType<typeof insertEventTransition>>;
    }
  | { kind: 'unchanged'; event: EventRecord }
  | { kind: 'not_found' };

export type { RecordObservationResult as ObservationRecordResult } from '@/server/world-model/services/observationService';
export { recordObservation } from '@/server/world-model/services/observationService';

function eventOutcomeLoopKey(eventId: string): string {
  return `event-outcome:${eventId}`;
}

function addHours(iso: string, hours: number): string {
  return new Date(new Date(iso).getTime() + hours * 60 * 60 * 1000).toISOString();
}

const ALLOWED_STATUS_TRANSITIONS: Record<EventStatus, readonly EventStatus[]> = {
  proposed: ['planned', 'cancelled'],
  planned: ['in_progress', 'completed', 'no_show', 'cancelled'],
  in_progress: ['completed', 'no_show', 'cancelled'],
  completed: [],
  cancelled: [],
  no_show: [],
  unknown: ['planned', 'cancelled'],
};

async function cancelOrResolveOutcomeLoop(
  event: EventRecord,
  status: EventStatus,
  db: WorldModelQueryExecutor,
): Promise<void> {
  const loop = await getOpenLoopByKey(
    event.userId,
    event.personaId,
    eventOutcomeLoopKey(event.id),
    event.workspaceId ?? '',
    db,
  );
  if (!loop) return;
  const targetStatus = status === 'cancelled' ? 'cancelled' : 'resolved';
  if (loop.status === 'open' || loop.status === 'scheduled' || loop.status === 'asked') {
    await updateOpenLoopStatus(loop.id, targetStatus, { note: `event became ${status}` }, db);
  }
}

export interface ApplyEventStatusChangeInput {
  eventId: string;
  toStatus: EventStatus;
  observation: ObservationInput;
  reason?: string;
}

async function fetchOrInsertEventTransition(
  db: WorldModelQueryExecutor,
  eventId: string,
  sourceObservationId: string,
  toStatus: EventStatus,
  build: () => Promise<EventTransition>,
): Promise<EventTransition> {
  const existing = await db.query<{
    id: string;
    event_id: string;
    from_status: EventStatus | null;
    to_status: EventStatus;
    reason: string | null;
    source_observation_id: string | null;
    confidence: number;
    transitioned_at: string;
  }>(
    `SELECT id, event_id, from_status, to_status, reason, source_observation_id, confidence, transitioned_at
     FROM world_model_event_transitions
     WHERE event_id = $1 AND source_observation_id = $2 AND to_status = $3
     LIMIT 1`,
    [eventId, sourceObservationId, toStatus],
  );
  if (existing.rows[0]) {
    const row = existing.rows[0];
    return {
      id: row.id,
      eventId: row.event_id,
      fromStatus: row.from_status ?? undefined,
      toStatus: row.to_status,
      reason: row.reason ?? undefined,
      sourceObservationId: row.source_observation_id ?? undefined,
      confidence: row.confidence,
      transitionedAt: row.transitioned_at,
    };
  }
  return build();
}

async function applyEventStatusChangeInTx(
  input: ApplyEventStatusChangeInput,
  allowOutcome: boolean,
  db: WorldModelQueryExecutor,
): Promise<PlanChangeResult> {
  if ((input.toStatus === 'completed' || input.toStatus === 'no_show') && !allowOutcome) {
    throw new Error('[world-model] completed/no_show requires confirmEventOutcome()');
  }

  const event = await getEventById(input.eventId, input.observation, db);
  if (!event) return { kind: 'not_found' };
  if (event.status === input.toStatus) return { kind: 'unchanged', event };
  if (!ALLOWED_STATUS_TRANSITIONS[event.status].includes(input.toStatus)) {
    throw new Error(`[world-model] invalid event transition ${event.status} -> ${input.toStatus}`);
  }

  const observationResult = await insertObservationWithResult(input.observation, db);
  const observation = observationResult.observation;
  const transition = await fetchOrInsertEventTransition(
    db,
    event.id,
    observation.id,
    input.toStatus,
    () =>
      insertEventTransition(
        {
          eventId: event.id,
          fromStatus: event.status,
          toStatus: input.toStatus,
          reason: input.reason,
          sourceObservationId: observation.id,
        },
        db,
      ),
  );
  await updateEventStatus(event.id, input.toStatus, observation.occurredAt, db);
  const updated = await getEventById(event.id, input.observation, db);
  if (!updated) return { kind: 'not_found' };

  if (
    input.toStatus === 'cancelled' ||
    input.toStatus === 'completed' ||
    input.toStatus === 'no_show'
  ) {
    await cancelOrResolveOutcomeLoop(updated, input.toStatus, db);
  }
  await enqueueOutboxEvent(
    {
      eventType: 'world.event.status_changed',
      aggregateType: 'event',
      aggregateId: updated.id,
      payload: {
        userId: updated.userId,
        personaId: updated.personaId,
        workspaceId: updated.workspaceId ?? '',
        fromStatus: event.status,
        toStatus: updated.status,
        observationId: observation.id,
      },
    },
    db,
  );
  return { kind: input.toStatus, event: updated, transition };
}

async function applyEventStatusChange(
  input: ApplyEventStatusChangeInput,
  allowOutcome: boolean,
): Promise<PlanChangeResult> {
  return withWorldModelTransaction(async (db) =>
    applyEventStatusChangeInTx(input, allowOutcome, db),
  );
}

/**
 * A plan change can cancel or advance a plan, but outcome states require
 * explicit evidence through confirmEventOutcome().
 */
export async function applyPlanChange(
  input: ApplyEventStatusChangeInput,
): Promise<PlanChangeResult> {
  return applyEventStatusChange(input, false);
}

export async function applyPlanChangeInTx(
  input: ApplyEventStatusChangeInput,
  db: WorldModelQueryExecutor,
): Promise<PlanChangeResult> {
  return applyEventStatusChangeInTx(input, false, db);
}

export interface PlannedEventWithFollowup {
  event: EventRecord;
  openLoop: Awaited<ReturnType<typeof insertOpenLoop>> | null;
}

export async function planEvent(input: {
  userId: string;
  personaId: string;
  workspaceId?: string;
  title: string;
  eventType: string;
  scheduledFor?: string;
  endsAt?: string;
  subjectEntityId?: string;
  counterpartEntityId?: string;
  observation: ObservationInput;
}): Promise<PlannedEventWithFollowup> {
  if (
    input.observation.userId !== input.userId ||
    input.observation.personaId !== input.personaId
  ) {
    throw new Error('[world-model] plan observation scope must match event scope');
  }
  if (
    input.workspaceId !== undefined &&
    input.observation.workspaceId !== undefined &&
    input.workspaceId !== input.observation.workspaceId
  ) {
    throw new Error('[world-model] plan observation workspace must match event scope');
  }
  return withWorldModelTransaction(async (db) => {
    const workspaceId = input.workspaceId ?? input.observation.workspaceId ?? '';
    const event = await insertEvent(
      {
        userId: input.userId,
        personaId: input.personaId,
        workspaceId,
        title: input.title,
        eventType: input.eventType,
        scheduledFor: input.scheduledFor,
        endsAt: input.endsAt,
        subjectEntityId: input.subjectEntityId,
        counterpartEntityId: input.counterpartEntityId,
        status: 'planned',
      },
      db,
    );
    const observationResult = await insertObservationWithResult(input.observation, db);
    const observation = observationResult.observation;
    await insertEventTransition(
      {
        eventId: event.id,
        fromStatus: undefined,
        toStatus: 'planned',
        reason: 'plan announced',
        sourceObservationId: observation.id,
      },
      db,
    );

    const followUpAt = input.endsAt
      ? addHours(input.endsAt, 1)
      : input.scheduledFor
        ? addHours(input.scheduledFor, 1)
        : undefined;
    const openLoop = await insertOpenLoop(
      {
        userId: input.userId,
        personaId: input.personaId,
        workspaceId,
        type: 'event_outcome',
        subjectId: input.subjectEntityId,
        question: `How did "${event.title}" go?`,
        deduplicationKey: eventOutcomeLoopKey(event.id),
        importance: 2,
        triggerAt: followUpAt,
      },
      db,
    );
    if (observationResult.created) {
      await enqueueOutboxEvent(
        {
          eventType: 'world.observation.created',
          aggregateType: 'observation',
          aggregateId: observation.id,
          payload: {
            ...input.observation.payload,
            userId: input.userId,
            personaId: input.personaId,
            workspaceId,
          },
        },
        db,
      );
    }
    await enqueueOutboxEvent(
      {
        eventType: 'world.event.created',
        aggregateType: 'event',
        aggregateId: event.id,
        payload: {
          userId: input.userId,
          personaId: input.personaId,
          workspaceId,
          title: event.title,
          eventType: event.eventType,
        },
      },
      db,
    );
    return { event, openLoop };
  });
}

export interface ConfirmEventOutcomeInput {
  eventId: string;
  observation: ObservationInput;
  outcome: 'completed' | 'no_show';
}

export async function confirmEventOutcome(
  input: ConfirmEventOutcomeInput,
): Promise<PlanChangeResult> {
  return applyEventStatusChange(
    {
      eventId: input.eventId,
      toStatus: input.outcome,
      observation: input.observation,
      reason: `outcome confirmed as ${input.outcome}`,
    },
    true,
  );
}

export async function confirmEventOutcomeInTx(
  input: ConfirmEventOutcomeInput,
  db: WorldModelQueryExecutor,
): Promise<PlanChangeResult> {
  return applyEventStatusChangeInTx(
    {
      eventId: input.eventId,
      toStatus: input.outcome,
      observation: input.observation,
      reason: `outcome confirmed as ${input.outcome}`,
    },
    true,
    db,
  );
}

export async function getEventHistory(
  eventId: string,
): Promise<Awaited<ReturnType<typeof listEventTimeline>>> {
  return listEventTimeline(eventId);
}

export async function resolveEventOpenLoop(eventId: string): Promise<void> {
  const event = await getEventById(eventId);
  if (!event) return;
  const loop = await getOpenLoopByKey(
    event.userId,
    event.personaId,
    eventOutcomeLoopKey(event.id),
    event.workspaceId ?? '',
  );
  if (loop && (loop.status === 'open' || loop.status === 'scheduled' || loop.status === 'asked')) {
    await updateOpenLoopStatus(loop.id, 'resolved', { note: `event became ${event.status}` });
  }
}

export type { EventTransitionInput };
