import type { ServerEventMap, ServerEventName } from '@/server/events/types';

type EventHandler<TEvent extends ServerEventName> = (payload: ServerEventMap[TEvent]) => void;

export interface ServerEventBus {
  publish<TEvent extends ServerEventName>(event: TEvent, payload: ServerEventMap[TEvent]): void;
  subscribe<TEvent extends ServerEventName>(
    event: TEvent,
    handler: EventHandler<TEvent>,
  ): () => void;
  clearAllSubscribers(): void;
}

class InMemoryServerEventBus implements ServerEventBus {
  private readonly handlers = new Map<ServerEventName, Set<(payload: unknown) => void>>();

  publish<TEvent extends ServerEventName>(event: TEvent, payload: ServerEventMap[TEvent]): void {
    const listeners = this.handlers.get(event);
    if (!listeners || listeners.size === 0) return;

    for (const listener of listeners) {
      try {
        listener(payload);
      } catch (error) {
        console.error(`[events] listener error for "${event}":`, error);
      }
    }
  }

  subscribe<TEvent extends ServerEventName>(
    event: TEvent,
    handler: EventHandler<TEvent>,
  ): () => void {
    const listeners = this.handlers.get(event) ?? new Set<(payload: unknown) => void>();
    listeners.add(handler as (payload: unknown) => void);
    this.handlers.set(event, listeners);

    return () => {
      const current = this.handlers.get(event);
      if (!current) return;
      current.delete(handler as (payload: unknown) => void);
      if (current.size === 0) {
        this.handlers.delete(event);
      }
    };
  }

  clearAllSubscribers(): void {
    this.handlers.clear();
  }
}

export function createServerEventBus(): ServerEventBus {
  return new InMemoryServerEventBus();
}
