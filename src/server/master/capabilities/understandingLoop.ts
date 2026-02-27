import type { MasterRepository } from '@/server/master/repository';
import type { WorkspaceScope } from '@/server/master/types';

export function shouldRunLearningCycleAt(date: Date): boolean {
  return date.getUTCHours() === 3 && date.getUTCMinutes() === 0;
}

export function runCapabilityUnderstandingCycle(
  repo: MasterRepository,
  scope: WorkspaceScope,
  now = new Date(),
): { updated: number; executed: boolean } {
  if (!shouldRunLearningCycleAt(now)) {
    return { updated: 0, executed: false };
  }
  const scores = repo.listCapabilityScores(scope);
  let updated = 0;
  for (const score of scores) {
    const boosted = Math.min(1, score.confidence + 0.01);
    repo.upsertCapabilityScore(
      scope,
      score.capability,
      boosted,
      score.benchmarkSummary,
      now.toISOString(),
    );
    updated += 1;
  }
  return { updated, executed: true };
}
