import type { MasterRepository } from '@/server/master/repository';
import type { WorkspaceScope } from '@/server/master/types';
import { DelegationInbox } from '@/server/master/delegation/inbox';

export class SubagentPool {
  constructor(
    private readonly repo: MasterRepository,
    private readonly inbox: DelegationInbox,
  ) {}

  async execute(
    scope: WorkspaceScope,
    runId: string,
    jobId: string,
    task: () => Promise<{ output: string; confidence?: number }>,
  ): Promise<void> {
    this.repo.updateDelegationJob(scope, jobId, { status: 'running' });
    this.inbox.publish(scope, runId, jobId, 'progress', { stage: 'running' });
    try {
      const result = await task();
      this.repo.updateDelegationJob(scope, jobId, { status: 'completed' });
      this.inbox.publish(scope, runId, jobId, 'result', result);
    } catch (error) {
      this.repo.updateDelegationJob(scope, jobId, {
        status: 'failed',
        lastError: error instanceof Error ? error.message : 'subagent execution failed',
      });
      this.inbox.publish(scope, runId, jobId, 'error', {
        error: error instanceof Error ? error.message : 'subagent execution failed',
      });
      throw error;
    }
  }
}
