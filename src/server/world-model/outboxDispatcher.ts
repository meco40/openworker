import { getWorldModelConfig } from '@/server/world-model/config';
import {
  closeWorldModelDb,
  runWithWorldModelScope,
  runWorldModelMigrations,
} from '@/server/world-model/db';
import { createGraphitiShadowHandler } from '@/server/world-model/graphiti/shadow';
import { createGraphitiProjectorHandler } from '@/server/world-model/graphiti/projector';
import {
  createProactiveQuestionHandler,
  createProactiveIntentFiredHandler,
} from '@/server/world-model/services/proactiveChannelDelivery';
import {
  projectMissionControlTaskCreated,
  projectMissionControlTaskDeleted,
  projectMissionControlTaskStatusChanged,
} from '@/server/world-model/services/missionControlBridge';
import {
  claimPendingOutboxEvents,
  markOutboxDispatched,
  markOutboxFailed,
} from '@/server/world-model/repositories/outboxRepository';
import type { OutboxEvent } from '@/server/world-model/types';
import type { WorldModelScope } from '@/server/world-model/scope';
import { listRuntimeWorldModelScopes } from '@/server/world-model/runtime/scopeDiscovery';

export type OutboxHandler = (event: OutboxEvent) => Promise<void>;

const handlers = new Map<string, OutboxHandler[]>();
const handlerKeys = new Map<string, Set<string>>();
const workerId = `world-model-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
let dispatchInFlight = false;

export function registerOutboxHandler(
  eventType: string,
  handler: OutboxHandler,
  key?: string,
): void {
  if (key) {
    const keys = handlerKeys.get(eventType) ?? new Set<string>();
    if (keys.has(key)) return;
    keys.add(key);
    handlerKeys.set(eventType, keys);
  }
  const list = handlers.get(eventType) ?? [];
  list.push(handler);
  handlers.set(eventType, list);
}

function hasHandlers(eventType: string): boolean {
  return (handlers.get(eventType)?.length ?? 0) > 0;
}

export async function dispatchOutboxOnce(batchSize?: number): Promise<number> {
  if (dispatchInFlight) return 0;
  dispatchInFlight = true;
  const config = getWorldModelConfig();
  const size = batchSize ?? config.outboxBatchSize;
  try {
    const pending = await claimPendingOutboxEvents(size, workerId);
    let handled = 0;
    for (const event of pending) {
      if (!hasHandlers(event.eventType)) {
        await markOutboxFailed(
          event.id,
          `[world-model:outbox] no handler registered for ${event.eventType}`,
          workerId,
        );
        continue;
      }
      try {
        const eventHandlers = handlers.get(event.eventType) ?? [];
        await Promise.all(eventHandlers.map((handler) => handler(event)));
        await markOutboxDispatched(event.id, workerId);
        handled += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await markOutboxFailed(event.id, message, workerId);
      }
    }
    return handled;
  } finally {
    dispatchInFlight = false;
  }
}

/** Dispatches one scoped batch while preserving RLS context for handlers. */
export function dispatchOutboxOnceInScope(
  scope: WorldModelScope,
  batchSize?: number,
): Promise<number> {
  return runWithWorldModelScope(scope, () => dispatchOutboxOnce(batchSize));
}

async function dispatchKnownScopes(batchSize?: number): Promise<number> {
  const scopes = listRuntimeWorldModelScopes();
  let handled = 0;
  for (const scope of scopes) {
    handled += await dispatchOutboxOnceInScope(scope, batchSize);
  }
  return handled;
}

let dispatcherTimer: ReturnType<typeof setInterval> | null = null;

export async function startOutboxDispatcher(): Promise<void> {
  const config = getWorldModelConfig();
  if (dispatcherTimer) return;
  const e2eAllowed = config.e2eEnabled && process.env.NODE_ENV !== 'production';
  if (!config.enabled && !e2eAllowed) return;
  await runWorldModelMigrations();
  if (config.graphitiShadowEnabled) {
    registerOutboxHandler(
      'world.observation.created',
      createGraphitiShadowHandler(),
      'world-model:graphiti-shadow',
    );
  }
  if (config.graphitiBackendEnabled) {
    const graphitiHandler = createGraphitiProjectorHandler();
    for (const eventType of [
      'world.observation.created',
      'world.assertion.created',
      'world.event.created',
      'world.relation.created',
    ] as const) {
      registerOutboxHandler(eventType, graphitiHandler, 'world-model:graphiti-projector');
    }
  }
  // Register proactive channel delivery handlers.
  if (!hasHandlers('proactive.question.requested')) {
    registerOutboxHandler(
      'proactive.question.requested',
      createProactiveQuestionHandler(),
      'world-model:proactive-question',
    );
  }
  if (!hasHandlers('proactive.intent.fired')) {
    registerOutboxHandler(
      'proactive.intent.fired',
      createProactiveIntentFiredHandler(),
      'world-model:proactive-intent',
    );
  }
  if (!hasHandlers('world.task.created')) {
    registerOutboxHandler(
      'world.task.created',
      projectMissionControlTaskCreated,
      'world-model:task-created',
    );
  }
  if (!hasHandlers('world.task.status_changed')) {
    registerOutboxHandler(
      'world.task.status_changed',
      projectMissionControlTaskStatusChanged,
      'world-model:task-status',
    );
  }
  if (!hasHandlers('world.task.deleted')) {
    registerOutboxHandler(
      'world.task.deleted',
      projectMissionControlTaskDeleted,
      'world-model:task-deleted',
    );
  }
  if (!config.enabled && !e2eAllowed) return;
  await dispatchKnownScopes().catch((error) => {
    console.error('[world-model:outbox] initial dispatch failed:', error);
  });
  dispatcherTimer = setInterval(() => {
    void dispatchKnownScopes().catch((error) => {
      console.error('[world-model:outbox] dispatch tick failed:', error);
    });
  }, config.outboxPollIntervalMs);
  dispatcherTimer.unref();
}

export async function stopOutboxDispatcher(): Promise<void> {
  if (dispatcherTimer) {
    clearInterval(dispatcherTimer);
    dispatcherTimer = null;
  }
  await closeWorldModelDb().catch(() => {});
}
