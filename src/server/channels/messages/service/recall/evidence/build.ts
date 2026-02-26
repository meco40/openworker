/**
 * Evidence reply building
 */

import type { Conversation, StoredMessage } from '@/server/channels/messages/repository';
import { isStrictEvidenceRecallEnabled } from '../../types';
import { performStrictSearch, type StrictSearchResult } from '../search/strict';
import { buildHighConfidenceResponse, buildLowConfidenceResponse } from './format';

export interface EvidenceReplyResult {
  content: string;
  metadata: Record<string, unknown>;
}

/**
 * Build strict evidence reply from chat and memory sources
 * Returns null if strict evidence recall is not enabled
 */
export async function buildStrictEvidenceReply(
  conversation: Conversation,
  userInput: string,
  isMemoryEnabled: boolean,
  chatHits: StoredMessage[],
): Promise<EvidenceReplyResult | null> {
  if (!isMemoryEnabled) return null;
  if (!conversation.personaId) return null;
  if (!isStrictEvidenceRecallEnabled()) return null;

  const result: StrictSearchResult = await performStrictSearch(conversation, userInput, chatHits);

  const {
    sortedRelevant,
    sortedContext,
    winner,
    runnerUp: _runnerUp,
    hasConflict,
    deduped,
    topicTokens,
  } = result;

  if (sortedRelevant.length === 0) {
    const { content, confidence } = buildLowConfidenceResponse(sortedContext);
    return {
      content,
      metadata: {
        ok: true,
        runtime: 'strict-recall',
        strictRecall: true,
        confidence,
        candidateCount: deduped.length,
        relevantCount: 0,
        topicTokens,
      },
    };
  }

  const { content, confidence } = buildHighConfidenceResponse(winner!, sortedRelevant, hasConflict);

  return {
    content,
    metadata: {
      ok: true,
      runtime: 'strict-recall',
      strictRecall: true,
      confidence,
      conflict: hasConflict,
      candidateCount: deduped.length,
      relevantCount: sortedRelevant.length,
      topicTokens,
    },
  };
}
