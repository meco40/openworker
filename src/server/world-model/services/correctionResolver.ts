import { getEventById, updateEventStatus } from '@/server/world-model/repositories/eventRepository';

export interface CorrectionResolution {
  action: 'none' | 'cancel_old' | 'replace' | 'ambiguous';
  replacedEventId?: string;
  reason?: string;
}

/**
 * Plan Korrektur-Semantik (Phase 4): Wenn ein Ersatzplan (z.B. "Ich gehe doch
 * nicht ins Kino, ich gehe Essen") erkannt wird, wird das alte Event nicht
 * geloescht, sondern als `cancelled` geschlossen (Historie bleibt). Das neue
 * Event wird ueber `replaces_event_id` verknuepft und bleibt `planned`, bis
 * eine Bestaetigung eintrifft.
 *
 * Diese Funktion ist eine reine Hilfsfunktion: Sie klassifiziert den Ersatz
 * und liefert die Entscheidung; die Transaktion fuehrt sie aus.
 */
export function resolveCorrection(input: {
  oldEventStatus: string;
  oldEventId: string;
  newEventProposed: boolean;
  kind: string;
}): CorrectionResolution {
  if (input.kind === 'cancellation') {
    return { action: 'cancel_old', replacedEventId: input.oldEventId, reason: 'user cancelled' };
  }
  // Ersatzplan: altes Event wird abgesagt, neues bleibt planned.
  if (input.kind === 'change' && input.newEventProposed && input.oldEventStatus === 'planned') {
    return {
      action: 'replace',
      replacedEventId: input.oldEventId,
      reason: 'replaced by a new plan',
    };
  }
  return { action: 'none' };
}

/**
 * Fuehrt die Korrektur für ein einzelnes Event aus (status -> cancelled) und
 * liefert true, wenn das Event vorher nicht already cancelled war.
 */
export async function applyCancellationForReplacement(eventId: string): Promise<boolean> {
  const event = await getEventById(eventId);
  if (!event) return false;
  if (event.status === 'cancelled') return false;
  await updateEventStatus(eventId, 'cancelled');
  return true;
}
