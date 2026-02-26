import { createId } from '@/shared/lib/ids';
import { deduplicateEvent } from '@/server/knowledge/eventDedup';
import { resolveRelativeTime } from '@/server/knowledge/timeResolver';
import type { IngestionWindow } from '@/server/knowledge/ingestionCursor';
import type { KnowledgeExtractionResult } from '@/server/knowledge/extractor';
import type { ExtractedEvent } from '@/server/knowledge/eventExtractor';
import type { KnowledgeRepositoryLike } from './types';
import { DEFAULT_EVENT_CONFIDENCE } from './constants';

export interface EventProcessingContext {
  window: IngestionWindow;
  extraction: KnowledgeExtractionResult;
  personaName: string;
}

export interface EventStorageResult {
  stored: number;
  confirmed: number;
}

/**
 * Resolve relative time expressions in an event to absolute dates.
 */
export function resolveEventTimes(
  event: ExtractedEvent,
  lastMessageTimestamp: string,
): {
  startDate: string;
  endDate: string;
} {
  const timeCtx = {
    messageTimestamp: lastMessageTimestamp,
    userTimezone: 'Europe/Berlin',
  };

  let resolvedStartDate = event.startDate;
  let resolvedEndDate = event.endDate;

  if (event.startDate) {
    const resolved = resolveRelativeTime(event.startDate, timeCtx);
    if (resolved) {
      resolvedStartDate = resolved.absoluteDate;
      if (resolved.absoluteDateEnd) {
        resolvedEndDate = resolved.absoluteDateEnd;
      }
    }
  }

  return {
    startDate: resolvedStartDate ?? event.startDate ?? '',
    endDate: resolvedEndDate ?? event.endDate ?? '',
  };
}

/**
 * Store events to the knowledge repository with deduplication.
 */
export async function storeEvents(
  repo: KnowledgeRepositoryLike,
  context: EventProcessingContext,
): Promise<EventStorageResult> {
  const { window, extraction } = context;

  if (
    !extraction.events ||
    extraction.events.length === 0 ||
    !repo.upsertEvent ||
    !repo.findOverlappingEvents ||
    !repo.appendEventSources
  ) {
    return { stored: 0, confirmed: 0 };
  }

  const lastMessageTimestamp =
    window.messages[window.messages.length - 1]?.createdAt || new Date().toISOString();

  let stored = 0;
  let confirmed = 0;

  for (const event of extraction.events) {
    const { startDate: resolvedStartDate, endDate: resolvedEndDate } = resolveEventTimes(
      event,
      lastMessageTimestamp,
    );

    const scope = { userId: window.userId, personaId: window.personaId };
    const dedupResult = deduplicateEvent(
      { ...event, startDate: resolvedStartDate, endDate: resolvedEndDate },
      scope,
      {
        findOverlappingEvents: repo.findOverlappingEvents.bind(repo),
        appendEventSources: repo.appendEventSources.bind(repo),
      },
    );

    if (dedupResult.action === 'new') {
      repo.upsertEvent({
        id: createId('kevt'),
        userId: window.userId,
        personaId: window.personaId,
        conversationId: window.conversationId,
        eventType: event.eventType,
        speakerRole: event.speakerRole,
        speakerEntity: event.speakerRole === 'assistant' ? window.personaId : 'User',
        subjectEntity: event.subject,
        counterpartEntity: event.counterpart,
        relationLabel: event.relationLabel,
        startDate: resolvedStartDate,
        endDate: resolvedEndDate,
        dayCount: event.dayCount,
        sourceSeqJson: JSON.stringify(event.sourceSeq),
        sourceSummary: `${event.subject} ${event.eventType} with ${event.counterpart}`,
        isConfirmation: false,
        confidence: DEFAULT_EVENT_CONFIDENCE,
      });
      stored++;
    } else if (dedupResult.action === 'confirmation') {
      // Confirmation boosts confidence on existing event
      const overlapping = repo.findOverlappingEvents({
        userId: window.userId,
        personaId: window.personaId,
        eventType: event.eventType,
        counterpartEntity: event.counterpart,
        from: resolvedStartDate ?? undefined,
        to: resolvedEndDate ?? undefined,
      });
      if (overlapping.length > 0) {
        repo.appendEventSources(overlapping[0].id, event.sourceSeq, 'Confirmed by user');
      }
      confirmed++;
    }
    // 'merge' action already handled by deduplicateEvent
  }

  return { stored, confirmed };
}
