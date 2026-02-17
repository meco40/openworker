/**
 * Recall scoring with dedup, freshness, confidence, and superseded filtering.
 *
 * Pure functions for adjusting recall scores based on fact metadata,
 * and detecting content-level duplicates.
 */

export type TemporalStatus = 'current' | 'past' | 'planned' | 'unknown';

export interface RecallScoreInput {
  baseScore: number;
  confidence: number;
  ageDays: number;
  temporalStatus?: TemporalStatus;
  isSupersceded?: boolean;
}

/**
 * Check if two memory content strings are duplicates (case-insensitive, trimmed).
 */
export function isDuplicateContent(newContent: string, existingContent: string): boolean {
  return newContent.trim().toLowerCase() === existingContent.trim().toLowerCase();
}

/**
 * Adjust a recall score based on confidence, freshness, temporal status,
 * and superseded state.
 *
 * Formula: baseScore * confidenceBoost * freshnessBoost * temporalBoost
 *
 * - Confidence floor: 0.5 (minimum boost from confidence)
 * - Freshness: 1.0 (<7d), 0.95 (<30d), 0.85 (<90d), 0.7 (>90d)
 * - Temporal: current=1.1, past=0.8, others=1.0
 * - Superseded: returns 0 immediately
 */
export function adjustRecallScore(input: RecallScoreInput): number {
  if (input.isSupersceded) return 0;

  const confidenceBoost = Math.max(0.5, input.confidence);

  let freshnessBoost: number;
  if (input.ageDays < 7) {
    freshnessBoost = 1.0;
  } else if (input.ageDays < 30) {
    freshnessBoost = 0.95;
  } else if (input.ageDays < 90) {
    freshnessBoost = 0.85;
  } else {
    freshnessBoost = 0.7;
  }

  let temporalBoost = 1.0;
  if (input.temporalStatus === 'current') {
    temporalBoost = 1.1;
  } else if (input.temporalStatus === 'past') {
    temporalBoost = 0.8;
  }

  return input.baseScore * confidenceBoost * freshnessBoost * temporalBoost;
}
