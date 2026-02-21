export function normalizeMem0Score(score: number | null): number {
  if (typeof score !== 'number' || !Number.isFinite(score)) return 0.75;
  if (score >= 0 && score <= 1) return score;
  if (score > 1 && score <= 100) return Math.min(1, score / 100);
  if (score < 0) return 0;
  return 0.75;
}
