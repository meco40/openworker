export type PrRiskLevel = 'low' | 'medium' | 'high';

export interface PrRiskInput {
  linesChanged: number;
}

export interface PrRiskResult {
  level: PrRiskLevel;
  requiresSplitReason: boolean;
}

const MEDIUM_THRESHOLD = 300;
const HIGH_THRESHOLD = 500;

function sanitizeLinesChanged(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.round(value));
}

export function classifyPrRisk(input: PrRiskInput): PrRiskResult {
  const linesChanged = sanitizeLinesChanged(input.linesChanged);

  if (linesChanged > HIGH_THRESHOLD) {
    return { level: 'high', requiresSplitReason: true };
  }
  if (linesChanged >= MEDIUM_THRESHOLD) {
    return { level: 'medium', requiresSplitReason: false };
  }
  return { level: 'low', requiresSplitReason: false };
}
