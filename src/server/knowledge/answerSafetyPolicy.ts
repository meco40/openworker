/**
 * Answer Safety Policy — evidence-based hedging for memory-backed answers.
 *
 * Prevents the persona from making confident claims when evidence is weak.
 */

export interface EvidenceAssessment {
  totalSources: number;
  avgConfidence: number;
  hasComputedAnswer: boolean;
  hasContradiction: boolean;
}

export type AnswerSafetyLevel = 'confident' | 'hedged' | 'caveat' | 'decline';

/**
 * Determines appropriate answer safety level based on available evidence.
 */
export function assessAnswerSafety(evidence: EvidenceAssessment): AnswerSafetyLevel {
  // Computed answer without contradiction → full confidence
  if (evidence.hasComputedAnswer && !evidence.hasContradiction) return 'confident';

  // Strong evidence
  if (evidence.totalSources >= 3 && evidence.avgConfidence >= 0.7) return 'confident';

  // Moderate evidence → hedge
  if (evidence.totalSources >= 1 && evidence.avgConfidence >= 0.5) return 'hedged';

  // Weak evidence → caveat
  if (evidence.totalSources >= 1) return 'caveat';

  // No evidence → decline
  return 'decline';
}

/**
 * Builds a system-prompt injection based on safety level.
 * Returns null when no restriction is needed (confident).
 */
export function buildSafetyInstruction(level: AnswerSafetyLevel): string | null {
  switch (level) {
    case 'confident':
      return null;
    case 'hedged':
      return (
        'ERINNERUNGSHINWEIS: Die verfuegbare Evidenz ist moderat. ' +
        'Antworte natuerlich, aber verwende Formulierungen wie "Soweit ich mich erinnere..." ' +
        'oder "Ich glaube..." statt absolute Behauptungen.'
      );
    case 'caveat':
      return (
        'ERINNERUNGSHINWEIS: Die verfuegbare Evidenz ist schwach. ' +
        'Sage klar, dass du dir nicht sicher bist. Verwende "Ich bin mir nicht ganz sicher, aber..." ' +
        'und biete an, dass der User dich korrigieren kann.'
      );
    case 'decline':
      return (
        'ERINNERUNGSHINWEIS: Zu dieser Frage gibt es keine zuverlaessige Erinnerung. ' +
        'Sage ehrlich, dass du dazu nichts in deiner Erinnerung findest. ' +
        'BEHAUPTE NICHTS ohne Evidenz.'
      );
  }
}
