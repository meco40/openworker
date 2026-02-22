import type { ServerEventBus } from '@/server/events/eventBus';
import { getServerEventBus } from '@/server/events/runtime';
import { getProactiveGateService } from '@/server/proactive/runtime';

export function registerProactiveEventSubscribers(
  bus: ServerEventBus = getServerEventBus(),
): () => void {
  const unsubscribeMessagePersisted = bus.subscribe('chat.message.persisted', (payload) => {
    const { conversation, message } = payload;
    if (!conversation.personaId) return;
    if (message.role !== 'user') return;

    try {
      getProactiveGateService().ingestMessages(conversation.userId, conversation.personaId, [
        {
          role: message.role,
          content: message.content,
          createdAt: message.createdAt,
        },
      ]);
    } catch (error) {
      console.error('Proactive ingest on chat.message.persisted failed:', error);
    }
  });

  const unsubscribeSummaryRefreshed = bus.subscribe('chat.summary.refreshed', (payload) => {
    if (!payload.personaId) return;

    try {
      getProactiveGateService().evaluate(payload.userId, payload.personaId);
    } catch (error) {
      console.error('Proactive evaluate on chat.summary.refreshed failed:', error);
    }
  });

  return () => {
    unsubscribeMessagePersisted();
    unsubscribeSummaryRefreshed();
  };
}
