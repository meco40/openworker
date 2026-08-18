import { getWorldModelConfig } from '@/server/world-model/config';
import { closeWorldModelDb, runWorldModelMigrations } from '@/server/world-model/db';
import { createGraphitiShadowHandler } from '@/server/world-model/graphiti/shadow';
import {
  claimPendingOutboxEvents,
  markOutboxDispatched,
  markOutboxFailed,
} from '@/server/world-model/repositories/outboxRepository';
import type { OutboxEvent } from '@/server/world-model/types';

export type OutboxHandler = (event: OutboxEvent) => Promise<void>;

const handlers = new Map<string, OutboxHandler[]>();
const workerId = `world-model-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
let dispatchInFlight = false;

export function registerOutboxHandler(eventType: string, handler: OutboxHandler): void {
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

let dispatcherTimer: ReturnType<typeof setInterval> | null = null;

export async function startOutboxDispatcher(): Promise<void> {
  const config = getWorldModelConfig();
  if (dispatcherTimer) return;
  const e2eAllowed = config.e2eEnabled && process.env.NODE_ENV !== 'production';
  if (!config.enabled && !e2eAllowed) return;
  await runWorldModelMigrations();
  if (config.graphitiShadowEnabled && !hasHandlers('world.observation.created')) {
    registerOutboxHandler('world.observation.created', createGraphitiShadowHandler());
  }
  if (!config.enabled && !e2eAllowed) return;
  await dispatchOutboxOnce().catch((error) => {
    console.error('[world-model:outbox] initial dispatch failed:', error);
  });
  dispatcherTimer = setInterval(() => {
    void dispatchOutboxOnce().catch((error) => {
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
