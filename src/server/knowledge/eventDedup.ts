import type { ExtractedEvent } from '@/server/knowledge/eventExtractor';
import type { KnowledgeEventFilter } from '@/server/knowledge/eventTypes';

/**
 * Result of the deduplication check for a single extracted event.
 *
 * - `new`          — no overlap found, caller should `upsertEvent()`
 * - `merge`        — overlapping event found, sources already appended via `appendEventSources()`
 * - `confirmation` — extracted event is a confirmation of an existing event (store separately)
 */
export interface DeduplicationResult {
  action: 'new' | 'merge' | 'confirmation';
  mergedIntoId?: string;
}

/**
 * Minimal repository interface used by the dedup function.
 * Keeps dedup testable without a full KnowledgeRepository.
 */
interface EventLookup {
  findOverlappingEvents(filter: KnowledgeEventFilter): Array<{ id: string; sourceSeqJson: string }>;
  appendEventSources(eventId: string, newSeqs: number[], newSummary?: string): void;
}

/**
 * Determines whether an extracted event should be stored as new, merged, or ignored.
 *
 * Rules:
 * 1. If the extracted event is flagged as `isConfirmation`, return `confirmation`.
 * 2. Find overlapping events with same eventType, counterpartEntity, and speakerRole.
 * 3. If overlap found → merge source sequences into existing event → return `merge`.
 * 4. Otherwise → return `new`.
 */
export function deduplicateEvent(
  extracted: ExtractedEvent,
  scope: { userId: string; personaId: string },
  repo: EventLookup,
): DeduplicationResult {
  // Confirmations are always stored separately — never merged
  if (extracted.isConfirmation) {
    return { action: 'confirmation' };
  }

  const filter: KnowledgeEventFilter = {
    userId: scope.userId,
    personaId: scope.personaId,
    eventType: extracted.eventType,
    counterpartEntity: extracted.counterpart,
    speakerRole: extracted.speakerRole,
    from: extracted.startDate,
    to: extracted.endDate,
  };

  const overlapping = repo.findOverlappingEvents(filter);

  if (overlapping.length === 0) {
    return { action: 'new' };
  }

  // Merge into the first overlapping event (most recent by start_date DESC)
  const target = overlapping[0];
  repo.appendEventSources(target.id, extracted.sourceSeq);

  return { action: 'merge', mergedIntoId: target.id };
}
