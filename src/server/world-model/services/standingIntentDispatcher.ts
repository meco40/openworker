import { enqueueOutboxEvent } from '@/server/world-model/repositories/outboxRepository';
import { insertOpenLoop } from '@/server/world-model/repositories/prospectiveRepository';
import { executeAction } from '@/server/world-model/services/actionService';
import type { WorldModelQueryExecutor } from '@/server/world-model/db';
import type { Observation, StandingIntentRecord } from '@/server/world-model/types';

/**
 * After a standing intent fires, this dispatcher turns the match into a
 * concrete, idempotent follow-up action via the transactional outbox.
 *
 * Firing is recorded inside the same transaction as the follow-up action by the
 * caller, so replaying the same source observation cannot double-fire.
 */
export interface StandingIntentDispatchInput {
  intent: StandingIntentRecord;
  observation: Observation;
}

export interface StandingIntentDispatchResult {
  dispatched: boolean;
  outboxEventId?: string;
  created: boolean;
}

/**
 * Materializes a fired intent as a canonical follow-up action. The later
 * channel delivery is still handled by the outbox, but the action attempt
 * records that the requested reminder/follow-up was created exactly once.
 */
export async function executeStandingIntentFollowUp(input: {
  intentId: string;
  userId: string;
  personaId: string;
  workspaceId?: string;
  description: string;
  firingObservationId: string;
}): Promise<void> {
  const result = await executeAction({
    scope: {
      userId: input.userId,
      personaId: input.personaId,
      workspaceId: input.workspaceId ?? '',
    },
    actionType: 'standing_intent.follow_up',
    idempotencyKey: `standing-intent-action:${input.intentId}:${input.firingObservationId}`,
    correlationId: input.firingObservationId,
    run: async () => {
      const loop = await insertOpenLoop({
        userId: input.userId,
        personaId: input.personaId,
        workspaceId: input.workspaceId ?? '',
        type: 'promised_follow_up',
        question: `Erinnerung: ${input.description}`,
        deduplicationKey: `standing-intent-follow-up:${input.intentId}:${input.firingObservationId}`,
      });
      return {
        ok: true,
        result: {
          providerId: 'world-model',
          target: `open-loop:${loop.id}`,
          timestamp: new Date().toISOString(),
          payload: { intentId: input.intentId, firingObservationId: input.firingObservationId },
        },
      };
    },
  });
  if (!result.succeeded) {
    throw new Error(result.error ?? 'standing intent follow-up action failed');
  }
}

export async function dispatchStandingIntentAction(
  input: StandingIntentDispatchInput,
  db?: WorldModelQueryExecutor,
): Promise<StandingIntentDispatchResult> {
  const { intent, observation } = input;

  // Concrete follow-up action payload. For V1 this is a reminder/task-style
  // intent; the action executor can later interpret this in the scheduler.
  const event = await enqueueOutboxEvent(
    {
      eventType: 'proactive.intent.fired',
      aggregateType: 'standing_intent',
      aggregateId: intent.id,
      idempotencyKey: `standing-intent-fire:${intent.id}:${observation.id}`,
      userId: intent.userId,
      personaId: intent.personaId,
      workspaceId: intent.workspaceId ?? '',
      payload: {
        userId: intent.userId,
        personaId: intent.personaId,
        workspaceId: intent.workspaceId ?? '',
        intentId: intent.id,
        description: intent.description,
        triggerTerms: intent.triggerTerms,
        firingObservationId: observation.id,
        sourceType: observation.sourceType,
        firedAt: observation.occurredAt,
      },
    },
    db,
  );

  return { dispatched: true, outboxEventId: event.id, created: event.created !== false };
}

/**
 * Registers a handler-friendly shape so the outbox dispatcher can route
 * `proactive.intent.fired` to an executor. Returns true if the handler
 * successfully processed the action (used by idempotency verification).
 */
export function buildIntentFiredHandler(
  onAction?: (payload: {
    intentId: string;
    userId: string;
    personaId: string;
    workspaceId?: string;
    description: string;
    firingObservationId: string;
  }) => Promise<void>,
) {
  return async (event: {
    id: string;
    eventType: string;
    aggregateType: string;
    aggregateId: string;
    payload: Record<string, unknown>;
  }): Promise<void> => {
    const payload = event.payload ?? {};
    const userId = String(payload.userId ?? '');
    const personaId = String(payload.personaId ?? '');
    const intentId = String(payload.intentId ?? event.aggregateId);
    const description = String(payload.description ?? '');
    const firingObservationId = String(payload.firingObservationId ?? '');
    const workspaceId = payload.workspaceId ? String(payload.workspaceId) : undefined;

    if (!onAction) {
      throw new Error('[world-model] no action handler for proactive.intent.fired');
    }
    await onAction({
      intentId,
      userId,
      personaId,
      workspaceId,
      description,
      firingObservationId,
    });
  };
}
