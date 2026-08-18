import {
  listArmedStandingIntents,
  listDueOpenLoops,
  listOverdueOpenLoops,
  markOpenLoopAsked,
  registerStandingIntentFire,
  updateOpenLoopStatus,
} from '@/server/world-model/repositories/prospectiveRepository';
import { withWorldModelTransaction } from '@/server/world-model/db';
import { dispatchStandingIntentAction } from '@/server/world-model/services/standingIntentDispatcher';
import type {
  Observation,
  OpenLoopRecord,
  StandingIntentFireResult,
  StandingIntentRecord,
} from '@/server/world-model/types';

export interface OpenLoopFollowupRule {
  isQuietTime?: (now: string) => boolean;
}

const DEFAULT_OVERDUE_MS = 24 * 60 * 60 * 1000;

export async function collectDueFollowUps(
  userId: string,
  personaId: string,
  at: string,
  workspaceId = '',
  rule?: OpenLoopFollowupRule,
): Promise<OpenLoopRecord[]> {
  const due = await listDueOpenLoops(userId, personaId, at, workspaceId);
  if (rule?.isQuietTime?.(at)) {
    return [];
  }
  return due;
}

export async function markFollowUpAsked(loop: OpenLoopRecord, now: string): Promise<void> {
  await markOpenLoopAsked(loop, now);
}

export async function resolveFollowUp(
  loop: OpenLoopRecord,
  note: string,
  resolvedObservationId?: string,
): Promise<void> {
  await updateOpenLoopStatus(loop.id, 'resolved', {
    note,
    resolvedObservationId,
    lastCheckedAt: new Date().toISOString(),
  });
}

export async function matchStandingIntents(
  observation: Observation,
): Promise<StandingIntentFireResult[]> {
  const intents = await listArmedStandingIntents(
    observation.userId,
    observation.personaId,
    observation.occurredAt,
    observation.workspaceId ?? '',
  );
  const now = observation.occurredAt;
  const results: StandingIntentFireResult[] = [];
  const haystack = [
    observation.sourceType,
    observation.sourceId,
    Object.values(observation.payload ?? {})
      .filter((value): value is string | number | boolean =>
        ['string', 'number', 'boolean'].includes(typeof value),
      )
      .join(' '),
  ]
    .join(' ')
    .toLowerCase();

  for (const intent of intents) {
    const fire = await evaluateIntent(intent, observation, haystack, now);
    if (fire.matched) results.push(fire);
  }
  return results;
}

async function evaluateIntent(
  intent: StandingIntentRecord,
  observation: Observation,
  haystack: string,
  now: string,
): Promise<StandingIntentFireResult> {
  if (intent.status !== 'armed') return { matched: false };
  if (intent.expiresAt && new Date(intent.expiresAt).getTime() < new Date(now).getTime())
    return { matched: false };
  if (intent.cooldownUntil && new Date(intent.cooldownUntil).getTime() > new Date(now).getTime())
    return { matched: false };
  if ((intent.maxFires ?? 0) > 0 && (intent.fireCount ?? 0) >= (intent.maxFires ?? 0))
    return { matched: false };

  const payload = observation.payload ?? {};
  const scopeMatches = (configured: string | undefined, keys: string[]): boolean => {
    if (!configured) return true;
    const actual = keys
      .map((key) => payload[key])
      .find((value) => value !== undefined && value !== null);
    return actual !== undefined && String(actual).toLowerCase() === configured.toLowerCase();
  };
  if (!scopeMatches(intent.subjectScope, ['subjectId', 'subject', 'subjectEntityId']))
    return { matched: false };
  if (!scopeMatches(intent.channelScope, ['channelType', 'channel'])) return { matched: false };
  if (!scopeMatches(intent.senderScope, ['senderId', 'sender', 'from'])) return { matched: false };

  let termMatched = false;
  if (Array.isArray(intent.triggerTerms) && intent.triggerTerms.length > 0) {
    termMatched = intent.triggerTerms.some((term) => haystack.includes(String(term).toLowerCase()));
  } else if (intent.eventType) {
    termMatched = intent.eventType === observation.sourceType;
  }
  if (!termMatched) return { matched: false };

  await withWorldModelTransaction(async (db) => {
    const dispatch = await dispatchStandingIntentAction({ intent, observation }, db);
    if (dispatch.created) {
      await registerStandingIntentFire(intent.id, now, db);
    }
  });
  return { matched: true, intent, observation };
}

export async function heartbeatScan(
  now: string,
  maxAgeMs = DEFAULT_OVERDUE_MS,
): Promise<{ overdue: OpenLoopRecord[] }> {
  const overdue = await listOverdueOpenLoops(maxAgeMs, now);
  return { overdue };
}

export type { StandingIntentFireResult };
