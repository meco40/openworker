import type { MeetingLedgerEntry } from '@/server/knowledge/repository';
import { adjustRecallScore } from '@/server/knowledge/recallScoring';
import { tokenizeQueryForRanking } from '../query/queryParser';
import { computeTokenOverlapScore } from './scoring';
import { computeEpisodeAge } from './episodeRanker';

export function rankLedgerByQuery(ledgerRows: MeetingLedgerEntry[], query: string): MeetingLedgerEntry[] {
  const tokens = tokenizeQueryForRanking(query);
  if (tokens.length === 0) return ledgerRows;
  return [...ledgerRows].sort((left, right) => {
    const leftOverlap = computeTokenOverlapScore(
      `${left.topicKey} ${left.counterpart || ''} ${left.decisions.join(' ')} ${left.negotiatedTerms.join(
        ' ',
      )} ${left.openPoints.join(' ')} ${left.actionItems.join(' ')}`,
      tokens,
    );
    const rightOverlap = computeTokenOverlapScore(
      `${right.topicKey} ${right.counterpart || ''} ${right.decisions.join(
        ' ',
      )} ${right.negotiatedTerms.join(' ')} ${right.openPoints.join(' ')} ${right.actionItems.join(' ')}`,
      tokens,
    );
    // Blend overlap with freshness decay via adjustRecallScore
    const leftScore = adjustRecallScore({
      baseScore: leftOverlap || 0.1,
      confidence: 0.5,
      ageDays: computeEpisodeAge(left.updatedAt),
    });
    const rightScore = adjustRecallScore({
      baseScore: rightOverlap || 0.1,
      confidence: 0.5,
      ageDays: computeEpisodeAge(right.updatedAt),
    });
    if (rightScore !== leftScore) return rightScore - leftScore;
    return Date.parse(String(right.updatedAt || '')) - Date.parse(String(left.updatedAt || ''));
  });
}
