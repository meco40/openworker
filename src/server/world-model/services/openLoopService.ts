import { withWorldModelTransaction } from '@/server/world-model/db';
import { enqueueOutboxEvent } from '@/server/world-model/repositories/outboxRepository';
import {
  claimDueOpenLoop,
  countAskedOpenLoopsToday,
  listDueOpenLoops,
  markOpenLoopAsked,
  releaseOpenLoopLease,
  updateOpenLoopStatus,
} from '@/server/world-model/repositories/prospectiveRepository';
import type { OpenLoopRecord } from '@/server/world-model/types';
import { decideOpenLoopDelivery } from '@/server/world-model/services/followUpPolicy';
import { decideNotification } from '@/server/world-model/services/notificationPolicy';
import { getWorldModelConfig } from '@/server/world-model/config';

export interface ChannelDeliveryResult {
  ok: boolean;
  providerMessageId?: string;
}

export type DecideDelivery = typeof decideOpenLoopDelivery;

export interface DeliveryPolicyContext {
  now: string;
  channelAvailable?: boolean;
  quietHours?: { start: number; end: number };
  dailyBudget?: number;
  deliveredToday?: number;
  userInteractionActive?: boolean;
}

export interface OpenLoopServiceDeps {
  listDueOpenLoops: (
    userId: string,
    personaId: string,
    at: string,
    workspaceId: string,
  ) => Promise<OpenLoopRecord[]>;
  claimDueOpenLoop?: (
    userId: string,
    personaId: string,
    at: string,
    workspaceId: string,
    leaseBy: string,
    leaseDurationMs: number,
  ) => Promise<OpenLoopRecord | null>;
  countAskedOpenLoopsToday?: (
    userId: string,
    personaId: string,
    workspaceId: string,
  ) => Promise<number>;
  decideDelivery: (
    loop: OpenLoopRecord,
    ctx: DeliveryPolicyContext,
  ) => { allow: boolean; reason: string };
  deliver: (loop: OpenLoopRecord) => Promise<ChannelDeliveryResult>;
  markAsked: (loopId: string, now: string) => Promise<void>;
  enqueueDelivery: (loop: OpenLoopRecord) => Promise<void>;
  releaseLease?: (loopId: string, nextAttemptAt: string | null) => Promise<void>;
  now?: () => string;
}

export interface DeliverDueOpenLoopsResult {
  totalDue: number;
  delivered: number;
  enqueued: number;
  rejected: number;
  failed: number;
  reasons: Record<string, number>;
}

function defaultEnqueue(loop: OpenLoopRecord): Promise<void> {
  return enqueueOpenLoopDelivery(loop);
}

export async function deliverDueOpenLoops(
  userId: string,
  personaId: string,
  workspaceIdOrDeps: string | Partial<OpenLoopServiceDeps> = '',
  depsOverride?: Partial<OpenLoopServiceDeps>,
): Promise<DeliverDueOpenLoopsResult> {
  const workspaceId = typeof workspaceIdOrDeps === 'string' ? workspaceIdOrDeps : '';
  const deps = typeof workspaceIdOrDeps === 'string' ? depsOverride : workspaceIdOrDeps;
  const now = deps?.now?.() ?? new Date().toISOString();
  const listDue = deps?.listDueOpenLoops ?? defaultListDueOpenLoops;
  const claim = deps?.claimDueOpenLoop ?? defaultClaimDueOpenLoop;
  const countToday = deps?.countAskedOpenLoopsToday ?? countAskedOpenLoopsToday;
  const decide = deps?.decideDelivery ?? decideOpenLoopDelivery;
  const deliver = deps?.deliver ?? defaultDeliverUnavailable;
  const markAsked = deps?.markAsked ?? markOpenLoopAsked;
  const enqueue = deps?.enqueueDelivery ?? defaultEnqueue;
  const releaseLease = deps?.releaseLease ?? defaultReleaseOpenLoopLease;
  const hasDirectDelivery = Boolean(deps?.deliver);

  const due = await listDue(userId, personaId, now, workspaceId);
  const result: DeliverDueOpenLoopsResult = {
    totalDue: due.length,
    delivered: 0,
    enqueued: 0,
    rejected: 0,
    failed: 0,
    reasons: {},
  };

  const config = getWorldModelConfig();
  const deliveredToday = await countToday(userId, personaId, workspaceId);
  const policyCtx: DeliveryPolicyContext = {
    now,
    quietHours: config.quietHours ?? undefined,
    dailyBudget: config.dailyProactiveBudget,
    deliveredToday,
  };
  const notificationConfig = {
    quietHours: config.quietHours ?? undefined,
    dailyBudget: config.dailyProactiveBudget,
  };

  for (const dueLoop of due) {
    // Claim one loop atomically with SKIP LOCKED so concurrent workers or
    // scheduler restarts never double-deliver the same follow-up.
    const loop = await claim(
      dueLoop.userId,
      dueLoop.personaId,
      now,
      dueLoop.workspaceId ?? workspaceId,
      'scheduler',
      60_000,
    );
    if (!loop) continue;

    const decision = decide(loop, policyCtx);

    // Notification-Policy (Ruhezeiten/Budget/Kanal) ergänzend anwenden.
    const notifDecision = decideNotification(
      {
        now,
        channel: loop.type,
        counts: { deliveredToday },
      },
      notificationConfig,
    );
    if (!notifDecision.allow) {
      await releaseLease(loop.id, calculateRetryAt(now, loop.attempts));
      result.rejected += 1;
      result.reasons[notifDecision.reason] = (result.reasons[notifDecision.reason] ?? 0) + 1;
      continue;
    }

    if (!decision.allow) {
      await releaseLease(loop.id, calculateRetryAt(now, loop.attempts));
      result.rejected += 1;
      result.reasons[decision.reason] = (result.reasons[decision.reason] ?? 0) + 1;
      continue;
    }

    try {
      await enqueue(loop);
    } catch {
      await releaseLease(loop.id, calculateRetryAt(now, loop.attempts));
      result.failed += 1;
      result.reasons.enqueue_failed = (result.reasons.enqueue_failed ?? 0) + 1;
      continue;
    }

    // The production runtime only enqueues. The outbox handler is the sole
    // sender and marks the loop as asked after a provider receipt exists.
    // Direct delivery remains available for explicitly injected integrations.
    if (!hasDirectDelivery) {
      await releaseLease(loop.id, null);
      result.enqueued += 1;
      continue;
    }

    const delivery = await deliver(loop);
    if (!delivery.ok) {
      await releaseLease(loop.id, calculateRetryAt(now, loop.attempts));
      result.failed += 1;
      result.reasons.delivery_failed = (result.reasons.delivery_failed ?? 0) + 1;
      continue;
    }

    await markAsked(loop.id, now);
    result.delivered += 1;
  }

  return result;
}

function calculateRetryAt(now: string, attempts: number): string {
  const backoffMs = Math.min(6 * 60 * 60 * 1000, 60_000 * 2 ** Math.min(attempts, 8));
  return new Date(new Date(now).getTime() + backoffMs).toISOString();
}

function defaultListDueOpenLoops(
  userId: string,
  personaId: string,
  at: string,
  workspaceId: string,
): Promise<OpenLoopRecord[]> {
  return listDueOpenLoops(userId, personaId, at, workspaceId);
}

function defaultClaimDueOpenLoop(
  userId: string,
  personaId: string,
  at: string,
  workspaceId: string,
  leaseBy: string,
  leaseDurationMs: number,
): Promise<OpenLoopRecord | null> {
  return claimDueOpenLoop(userId, personaId, at, workspaceId, leaseBy, leaseDurationMs);
}

/**
 * Fallback when no real channel deliverer is provided: marks as failed so the
 * caller can detect misconfiguration instead of silently skipping.
 */
async function defaultDeliverUnavailable(_loop: OpenLoopRecord): Promise<ChannelDeliveryResult> {
  return { ok: false };
}

function defaultReleaseOpenLoopLease(loopId: string, nextAttemptAt: string | null): Promise<void> {
  return releaseOpenLoopLease(loopId, nextAttemptAt);
}

/**
 * Enqueues a delivery intent atomically inside the world-model transaction.
 * Used by the prospective runtime so a crash before delivery can be
 * reconciled by re-running the due scan.
 */
export async function enqueueOpenLoopDelivery(loop: OpenLoopRecord): Promise<void> {
  await enqueueOutboxEvent({
    eventType: 'proactive.question.requested',
    aggregateType: 'open_loop',
    aggregateId: loop.id,
    idempotencyKey: `proactive-question:${loop.id}:${loop.attempts}`,
    userId: loop.userId,
    personaId: loop.personaId,
    workspaceId: loop.workspaceId ?? '',
    payload: {
      userId: loop.userId,
      personaId: loop.personaId,
      workspaceId: loop.workspaceId ?? '',
      openLoopId: loop.id,
      question: loop.question,
    },
  });
}

/**
 * Enqueues a delivery intent + marks the loop asked in one transaction. This
 * avoids delivery requests being lost if the runtime crashes between enqueue
 * and the ask-marking step.
 */
export async function enqueueAndMarkAsked(loop: OpenLoopRecord, now: string): Promise<void> {
  await withWorldModelTransaction(async (client) => {
    await enqueueOutboxEvent(
      {
        eventType: 'proactive.question.requested',
        aggregateType: 'open_loop',
        aggregateId: loop.id,
        idempotencyKey: `proactive-question:${loop.id}:${loop.attempts}`,
        userId: loop.userId,
        personaId: loop.personaId,
        workspaceId: loop.workspaceId ?? '',
        payload: {
          userId: loop.userId,
          personaId: loop.personaId,
          workspaceId: loop.workspaceId ?? '',
          openLoopId: loop.id,
          question: loop.question,
        },
      },
      client,
    );
    await markOpenLoopAsked(loop.id, now, client);
  });
}

export async function resolveOpenLoopAsAnswered(
  loopId: string,
  observationId?: string,
  note?: string,
): Promise<void> {
  await updateOpenLoopStatus(loopId, 'answered', {
    resolvedObservationId: observationId,
    note,
    lastCheckedAt: new Date().toISOString(),
  });
}

export async function resolveOpenLoopAsAnsweredInTx(
  loopId: string,
  observationId: string | undefined,
  note: string | undefined,
  db: Parameters<typeof updateOpenLoopStatus>[3],
): Promise<void> {
  await updateOpenLoopStatus(
    loopId,
    'answered',
    {
      resolvedObservationId: observationId,
      note,
      lastCheckedAt: new Date().toISOString(),
    },
    db,
  );
}

export async function claimAndDeliverDueOpenLoopsWithinTransaction(
  userId: string,
  personaId: string,
): Promise<DeliverDueOpenLoopsResult> {
  return withWorldModelTransaction(async (client) => {
    const now = new Date().toISOString();
    const due = await listDueOpenLoops(userId, personaId, now, '', 50, client);
    for (const loop of due) {
      await enqueueOutboxEvent(
        {
          eventType: 'proactive.question.requested',
          aggregateType: 'open_loop',
          aggregateId: loop.id,
          idempotencyKey: `proactive-question:${loop.id}:${loop.attempts}`,
          userId,
          personaId,
          workspaceId: loop.workspaceId ?? '',
          payload: { userId, personaId, openLoopId: loop.id, question: loop.question },
        },
        client,
      );
    }
    return {
      totalDue: due.length,
      delivered: 0,
      enqueued: due.length,
      rejected: 0,
      failed: 0,
      reasons: {},
    };
  });
}
