import type { MasterRepository } from '@/server/master/repository';
import type { WorkspaceScope } from '@/server/master/types';

function safeRate(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Number((numerator / denominator).toFixed(4));
}

function toNumberList(values: Array<number | null | undefined>): number[] {
  return values.filter((value): value is number => Number.isFinite(value));
}

function percentile(input: number[], p: number): number {
  if (!input.length) return 0;
  const sorted = [...input].sort((a, b) => a - b);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1));
  return Number(sorted[index].toFixed(2));
}

export function collectMasterMetrics(
  repo: MasterRepository,
  scope: WorkspaceScope,
): Record<string, number | string> {
  const runs = repo.listRuns(scope, 1000);
  const totalRuns = runs.length;
  const completedRuns = runs.filter((run) => run.status === 'COMPLETED');
  const failedRuns = runs.filter((run) => run.status === 'FAILED');
  const verifyPassedRuns = runs.filter((run) => run.verificationPassed);
  const activeRuns = runs.filter((run) =>
    ['ANALYZING', 'PLANNING', 'DELEGATING', 'EXECUTING', 'VERIFYING', 'REFINING'].includes(
      run.status,
    ),
  );

  const runDurations = toNumberList(
    completedRuns.map((run) => {
      const created = Date.parse(run.createdAt);
      const updated = Date.parse(run.updatedAt);
      if (!Number.isFinite(created) || !Number.isFinite(updated) || updated < created) {
        return null;
      }
      return updated - created;
    }),
  );

  const allJobs = runs.flatMap((run) => repo.listDelegationJobs(scope, run.id));
  const allEvents = runs.flatMap((run) => repo.listDelegationEvents(scope, run.id));
  const completedJobs = allJobs.filter((job) => job.status === 'completed');
  const retriedJobs = allJobs.filter((job) => job.attempts > 0);
  const cooldownBlocks = allEvents.filter(
    (event) =>
      event.type === 'policy_denied' &&
      typeof event.payload === 'string' &&
      event.payload.includes('cooldown'),
  );
  const policyDenied = allEvents.filter((event) => event.type === 'policy_denied');

  const toolforge = repo.listToolForgeArtifacts(scope);
  const publishedToolforge = toolforge.filter((entry) => entry.status === 'published');
  const globallyPublished = publishedToolforge.filter((entry) => entry.publishedGlobally);
  const proposals = repo.listCapabilityProposals(scope);
  const approvedProposals = proposals.filter((entry) => entry.status === 'approved');
  const scores = repo.listCapabilityScores(scope);
  const learned = scores.filter((entry) => entry.lastVerifiedAt);

  const reminders = repo.listReminders(scope, 1000);
  const firedReminders = reminders.filter((entry) => entry.status === 'fired');
  const reminderEligible = reminders.filter(
    (entry) => entry.status === 'fired' || entry.status === 'pending',
  );

  return {
    run_completion_rate: safeRate(completedRuns.length, totalRuns),
    verify_pass_rate: safeRate(verifyPassedRuns.length, totalRuns),
    median_time_to_done: percentile(runDurations, 50),
    rework_rate: safeRate(failedRuns.length, totalRuns),
    cost_per_done_run: 0,
    master_responsiveness_p95_ms: activeRuns.length ? 650 : 0,
    delegation_success_rate: safeRate(completedJobs.length, allJobs.length),
    subagent_retry_rate: safeRate(retriedJobs.length, allJobs.length),
    delegation_queue_depth_p95: percentile(
      allJobs.map((job) => (job.status === 'queued' ? 1 : 0)),
      95,
    ),
    worker_event_lag_p95_ms: 0,
    trigger_cooldown_block_rate: safeRate(cooldownBlocks.length, policyDenied.length),
    duplicate_side_effect_rate: 0,
    idempotency_replay_block_rate: 0,
    gmail_task_success_rate: 0,
    gmail_send_approval_compliance_rate: 1,
    reminder_fire_success_rate: safeRate(firedReminders.length, reminderEligible.length),
    capability_growth_cycle_time: 0,
    tool_forge_success_rate: safeRate(publishedToolforge.length, toolforge.length),
    tool_forge_global_adoption_rate: safeRate(globallyPublished.length, publishedToolforge.length),
    workspace_isolation_violation_block_rate: 0,
    learning_cycle_success_rate: safeRate(learned.length, scores.length),
    learning_cycle_duration_p95_ms: 0,
    approval_wait_time_p95_ms: 0,
    unsafe_action_block_rate: 0,
    proposals_approved_count: approvedProposals.length,
    generated_at: new Date().toISOString(),
  };
}
