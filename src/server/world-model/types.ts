export type Modality =
  | 'reported'
  | 'planned'
  | 'expected'
  | 'inferred'
  | 'observed'
  | 'confirmed'
  | 'denied';

export type EventStatus =
  | 'proposed'
  | 'planned'
  | 'in_progress'
  | 'completed'
  | 'cancelled'
  | 'no_show'
  | 'unknown';

export type TaskStatus =
  | 'proposed'
  | 'planned'
  | 'in_progress'
  | 'waiting'
  | 'completed'
  | 'cancelled'
  | 'failed';

export type OpenLoopType =
  | 'clarification'
  | 'confirmation'
  | 'event_outcome'
  | 'dependency'
  | 'missing_context'
  | 'promised_follow_up';

export type OpenLoopStatus =
  | 'open'
  | 'scheduled'
  | 'asked'
  | 'answered'
  | 'resolved'
  | 'cancelled'
  | 'expired';

export type StandingIntentStatus = 'armed' | 'cooldown' | 'done' | 'cancelled' | 'expired';

export type OutboxStatus = 'pending' | 'dispatched' | 'failed' | 'permanent_failure';

export interface ObservationInput {
  userId: string;
  personaId: string;
  workspaceId?: string;
  sourceType:
    | 'chat_message'
    | 'email'
    | 'calendar_event'
    | 'location_signal'
    | 'tool_execution'
    | 'outbound_message'
    | 'user_confirmation'
    | 'automation'
    | 'manual';
  sourceId: string;
  occurredAt: string;
  payload: Record<string, unknown>;
  sourceAuthority?: string;
}

export interface Observation extends ObservationInput {
  id: string;
  receivedAt: string;
}

export interface EventInput {
  userId: string;
  personaId: string;
  workspaceId?: string;
  title: string;
  eventType: string;
  subjectEntityId?: string;
  counterpartEntityId?: string;
  scheduledFor?: string;
  endsAt?: string;
  status?: EventStatus;
  observedAt?: string;
  idempotencyKey?: string;
  replacesEventId?: string;
}

export interface EventRecord extends EventInput {
  id: string;
  status: EventStatus;
  createdAt: string;
  updatedAt: string;
  replacesEventId?: string;
}

export interface EventTransitionInput {
  eventId: string;
  toStatus: EventStatus;
  fromStatus?: EventStatus;
  reason?: string;
  sourceObservationId?: string;
  confidence?: number;
  transitionedAt?: string;
}

export interface EventTransition extends EventTransitionInput {
  id: string;
  transitionedAt: string;
}

export interface OpenLoopInput {
  userId: string;
  personaId: string;
  workspaceId?: string;
  type: OpenLoopType;
  subjectId?: string;
  question?: string;
  missingInformation?: string;
  importance?: number;
  triggerAt?: string;
  doNotAskBefore?: string;
  deduplicationKey: string;
  maxAttempts?: number;
}

export interface OpenLoopRecord extends OpenLoopInput {
  id: string;
  status: OpenLoopStatus;
  attempts: number;
  lastCheckedAt?: string;
  lastAskedAt?: string;
  resolvedObservationId?: string;
  note?: string;
  createdAt: string;
  updatedAt: string;
}

export interface StandingIntentInput {
  userId: string;
  personaId: string;
  workspaceId?: string;
  description: string;
  triggerTerms: string[];
  eventType?: string;
  subjectScope?: string;
  channelScope?: string;
  senderScope?: string;
  expiresAt?: string;
  cooldownMs?: number;
  maxFires?: number;
  deduplicationKey: string;
}

export interface StandingIntentRecord extends StandingIntentInput {
  id: string;
  status: StandingIntentStatus;
  cooldownUntil?: string;
  fireCount: number;
  lastFiredAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface OutboxEventInput {
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  idempotencyKey?: string;
  correlationId?: string;
  userId?: string;
  personaId?: string;
  workspaceId?: string;
}

export interface OutboxEvent extends OutboxEventInput {
  id: string;
  status: OutboxStatus;
  attempts: number;
  errorMessage?: string;
  createdAt: string;
  dispatchedAt?: string;
  created?: boolean;
}

export type StandingIntentFireResult =
  | { matched: true; intent: StandingIntentRecord; observation: Observation }
  | { matched: false };
