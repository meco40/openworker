import type { MasterRepository } from '@/server/master/repository';
import type { WorkspaceScope } from '@/server/master/types';
import {
  runCapabilityUnderstandingCycle,
  shouldRunLearningCycleAt,
} from '@/server/master/capabilities/understandingLoop';

export type LearningPolicyRecommendation = 'safe' | 'balanced' | 'fast';

export function recommendLearningPolicy(input: {
  failureRate: number;
  verifyPassRate: number;
}): LearningPolicyRecommendation {
  if (input.failureRate > 0.2) return 'safe';
  if (input.verifyPassRate > 0.9) return 'fast';
  return 'balanced';
}

export async function runDailyLearningLoop(
  repo: MasterRepository,
  scope: WorkspaceScope,
  now = new Date(),
): Promise<{ executed: boolean; updated: number; scheduledAt: string }> {
  const cycle = await runCapabilityUnderstandingCycle(repo, scope, now);
  return {
    executed: cycle.executed,
    updated: cycle.updated,
    scheduledAt: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} 03:00`,
  };
}

export function isLearningWindow(date: Date): boolean {
  return shouldRunLearningCycleAt(date);
}
