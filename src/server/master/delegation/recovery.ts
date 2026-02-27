import type { MasterRepository } from '@/server/master/repository';
import type { WorkspaceScope } from '@/server/master/types';

export function recoverDelegationQueue(
  repo: MasterRepository,
  scope: WorkspaceScope,
  runId: string,
): number {
  const jobs = repo.listDelegationJobs(scope, runId);
  let recovered = 0;
  for (const job of jobs) {
    if (job.status === 'running') {
      repo.updateDelegationJob(scope, job.id, {
        status: 'queued',
        attempts: job.attempts + 1,
      });
      repo.appendDelegationEvent(scope, {
        runId,
        jobId: job.id,
        type: 'progress',
        payload: JSON.stringify({ recovered: true }),
      });
      recovered += 1;
    }
  }
  return recovered;
}
