import type { IngestionWindow } from '@/server/knowledge/ingestionCursor';
import type { KnowledgeRepositoryLike } from './types';
import type { KnowledgeExtractionResult } from '@/server/knowledge/extractor';
import { inferSourceStart, inferSourceEnd } from './qualityChecks';
import { DEFAULT_TOPIC_KEY } from './constants';

export interface EpisodeInput {
  window: IngestionWindow;
  extraction: KnowledgeExtractionResult;
  facts: string[];
  filteredDecisions: string[];
  filteredNegotiatedTerms: string[];
  filteredOpenPoints: string[];
  filteredActionItems: string[];
}

/**
 * Upsert episode and meeting ledger to the knowledge repository.
 */
export function upsertEpisodeAndLedger(repo: KnowledgeRepositoryLike, input: EpisodeInput): void {
  const { window, extraction, facts } = input;
  const topicKey = String(extraction.meetingLedger.topicKey || '').trim() || DEFAULT_TOPIC_KEY;
  const sourceSeqStart = inferSourceStart(window);
  const sourceSeqEnd = inferSourceEnd(window);

  repo.upsertEpisode({
    userId: window.userId,
    personaId: window.personaId,
    conversationId: window.conversationId,
    topicKey,
    counterpart: extraction.meetingLedger.counterpart,
    teaser: extraction.teaser,
    episode: extraction.episode,
    facts,
    sourceSeqStart,
    sourceSeqEnd,
    sourceRefs: extraction.meetingLedger.sourceRefs,
    eventAt: window.messages[window.messages.length - 1]?.createdAt || null,
  });

  repo.upsertMeetingLedger({
    userId: window.userId,
    personaId: window.personaId,
    conversationId: window.conversationId,
    topicKey,
    counterpart: extraction.meetingLedger.counterpart,
    eventAt: window.messages[window.messages.length - 1]?.createdAt || null,
    participants: extraction.meetingLedger.participants,
    decisions: input.filteredDecisions,
    negotiatedTerms: input.filteredNegotiatedTerms,
    openPoints: input.filteredOpenPoints,
    actionItems: input.filteredActionItems,
    sourceRefs: extraction.meetingLedger.sourceRefs,
    confidence: extraction.meetingLedger.confidence,
  });
}
