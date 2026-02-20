import type { KnowledgeEventFilter, EventAggregationResult } from '@/server/knowledge/eventTypes';

export interface EventAnswerScope {
  userId: string;
  personaId: string;
}

export interface EventAnswerFilter {
  eventType?: string;
  counterpartEntity?: string;
  from?: string;
  to?: string;
}

/**
 * Minimal repo interface — keeps this module testable without a full KnowledgeRepository.
 */
interface EventCountRepository {
  countUniqueDays(filter: KnowledgeEventFilter): EventAggregationResult;
}

const EVENT_TYPE_LABELS: Record<string, string> = {
  shared_sleep: 'geschlafen',
  visit: 'besucht',
  trip: 'gereist',
  meeting: 'getroffen',
  activity: 'unternommen',
  meal: 'gegessen',
  appointment: 'einen Termin gehabt',
  celebration: 'gefeiert',
};

/**
 * Computes a factual answer string for count-type queries
 * (e.g., "Wie viele Tage hat Nata mit Max geschlafen?").
 *
 * Returns `null` when there are no matching events.
 */
export function computeEventAnswer(
  eventFilter: EventAnswerFilter,
  scope: EventAnswerScope,
  repo: EventCountRepository,
): string | null {
  const filter: KnowledgeEventFilter = {
    userId: scope.userId,
    personaId: scope.personaId,
    eventType: eventFilter.eventType,
    counterpartEntity: eventFilter.counterpartEntity,
    from: eventFilter.from,
    to: eventFilter.to,
  };

  const result = repo.countUniqueDays(filter);

  if (result.uniqueDayCount === 0) return null;

  const counterpart = eventFilter.counterpartEntity
    ? capitalize(eventFilter.counterpartEntity)
    : 'der Person';

  const verb = EVENT_TYPE_LABELS[eventFilter.eventType || ''] || 'etwas gemacht';
  const dayWord = result.uniqueDayCount === 1 ? 'Tag' : 'Tage';

  return `BERECHNETE ANTWORT: Insgesamt ${result.uniqueDayCount} ${dayWord} mit ${counterpart} ${verb}. (Basierend auf ${result.eventCount} erfassten Ereignissen, Zeitraum: ${result.uniqueDays[0]} bis ${result.uniqueDays[result.uniqueDays.length - 1]})`;
}

function capitalize(text: string): string {
  if (!text) return text;
  return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
}
