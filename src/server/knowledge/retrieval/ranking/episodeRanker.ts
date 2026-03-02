import type { KnowledgeEpisode } from '@/server/knowledge/repository';
import { adjustRecallScore } from '@/server/knowledge/recallScoring';
import { adjustScoreByStrategy } from '@/server/knowledge/personaStrategies';
import type { PersonaType } from '@/server/personas/personaTypes';
import { tokenizeQueryForRanking } from '../query/queryParser';
import { computeTokenOverlapScore, detectEmotionalToneInText } from './scoring';

export function computeEpisodeAge(updatedAt: string | null | undefined): number {
  const ts = Date.parse(String(updatedAt || ''));
  if (!Number.isFinite(ts)) return 365;
  return Math.max(0, (Date.now() - ts) / 86_400_000);
}

export function rankEpisodesByQuery(
  episodes: KnowledgeEpisode[],
  query: string,
  personaType: PersonaType = 'general',
): KnowledgeEpisode[] {
  const tokens = tokenizeQueryForRanking(query);
  if (tokens.length === 0) return episodes;
  return [...episodes].sort((left, right) => {
    const leftOverlap = computeTokenOverlapScore(
      `${left.topicKey} ${left.teaser} ${left.episode} ${(left.facts || []).join(' ')}`,
      tokens,
    );
    const rightOverlap = computeTokenOverlapScore(
      `${right.topicKey} ${right.teaser} ${right.episode} ${(right.facts || []).join(' ')}`,
      tokens,
    );
    // Blend overlap with freshness decay via adjustRecallScore
    let leftScore = adjustRecallScore({
      baseScore: leftOverlap || 0.1,
      confidence: 0.5,
      ageDays: computeEpisodeAge(left.updatedAt),
    });
    let rightScore = adjustRecallScore({
      baseScore: rightOverlap || 0.1,
      confidence: 0.5,
      ageDays: computeEpisodeAge(right.updatedAt),
    });
    // Apply persona-type-specific score adjustments
    leftScore = adjustScoreByStrategy(leftScore, personaType, {
      emotionalTone: detectEmotionalToneInText((left.facts || []).join(' ')),
      type: left.topicKey,
    });
    rightScore = adjustScoreByStrategy(rightScore, personaType, {
      emotionalTone: detectEmotionalToneInText((right.facts || []).join(' ')),
      type: right.topicKey,
    });
    if (rightScore !== leftScore) return rightScore - leftScore;
    return Date.parse(String(right.updatedAt || '')) - Date.parse(String(left.updatedAt || ''));
  });
}
