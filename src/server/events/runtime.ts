import { createServerEventBus, type ServerEventBus } from '@/server/events/eventBus';

declare global {
  var __serverEventBus: ServerEventBus | undefined;
}

export function getServerEventBus(): ServerEventBus {
  if (!globalThis.__serverEventBus) {
    globalThis.__serverEventBus = createServerEventBus();
  }
  return globalThis.__serverEventBus;
}
