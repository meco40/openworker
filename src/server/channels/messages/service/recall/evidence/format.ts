/**
 * Evidence formatting utilities
 */

import type { StrictRecallCandidate } from '../types';

/**
 * Format evidence lines from candidates
 */
export function formatEvidenceLines(candidates: StrictRecallCandidate[]): string[] {
  return candidates.map(
    (candidate, index) =>
      `${index + 1}. [${candidate.source}/${candidate.role}] ${candidate.text}${candidate.createdAt ? ` (${candidate.createdAt})` : ''}`,
  );
}

/**
 * Build low confidence response when no relevant candidates found
 */
export function buildLowConfidenceResponse(sortedContext: StrictRecallCandidate[]): {
  content: string;
  confidence: 'low';
} {
  const contextLines = sortedContext.slice(0, 3).map((candidate) => `- "${candidate.text}"`);
  const content = contextLines.length
    ? [
        'Ich finde keine belastbare Erinnerung dazu, welche Übung du heute nochmal machen willst.',
        '',
        'Ich finde nur diese Aussagen zum Zeitkontext:',
        ...contextLines,
      ].join('\n')
    : 'Ich finde keine belastbare Erinnerung dazu, welche Übung du heute nochmal machen willst.';

  return { content, confidence: 'low' };
}

/**
 * Build high/medium confidence response when candidates found
 */
export function buildHighConfidenceResponse(
  winner: StrictRecallCandidate,
  sortedRelevant: StrictRecallCandidate[],
  hasConflict: boolean,
): { content: string; evidenceLines: string[]; confidence: 'high' | 'medium' } {
  const evidenceCandidates = hasConflict ? sortedRelevant.slice(0, 3) : sortedRelevant.slice(0, 2);

  const answer = hasConflict
    ? [
        'Ich finde mehrere gleich plausible Erinnerungen und kann keine eindeutig priorisieren.',
        `Mögliche Aussagen: ${sortedRelevant
          .slice(0, 3)
          .map((candidate) => `"${candidate.text}"`)
          .join(' | ')}`,
      ].join('\n')
    : `Nach den belegbaren Erinnerungen willst du heute nochmal: "${winner.text}"`;

  const evidenceLines = evidenceCandidates.map(
    (candidate, index) =>
      `${index + 1}. [${candidate.source}/${candidate.role}] ${candidate.text}${candidate.createdAt ? ` (${candidate.createdAt})` : ''}`,
  );

  return {
    content: [answer, '', 'Belege:', ...evidenceLines].join('\n'),
    evidenceLines,
    confidence: hasConflict ? 'medium' : 'high',
  };
}
