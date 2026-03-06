import type { MasterRepository } from '@/server/master/repository';
import type { WorkspaceScope } from '@/server/master/types';
import { DelegationInbox } from '@/server/master/delegation/inbox';
import {
  claimSubagentSession,
  completeSubagentSession,
  failSubagentSession,
  syncSubagentSessionHeartbeat,
} from '@/server/master/delegation/sessionService';

export class SubagentPool {
  private readonly ownerId = `subagent-pool:${process.pid}`;

  constructor(
    private readonly repo: MasterRepository,
    private readonly inbox: DelegationInbox,
  ) {}

  async execute(
    scope: WorkspaceScope,
    runId: string,
    jobId: string,
    sessionId: string | null,
    task: () => Promise<{ output: string; confidence?: number }>,
  ): Promise<void> {
    if (sessionId) {
      claimSubagentSession(this.repo, scope, sessionId, { ownerId: this.ownerId });
    }
    this.repo.updateDelegationJob(scope, jobId, { status: 'running' });
    this.inbox.publish(scope, runId, jobId, 'progress', { stage: 'running' });
    if (sessionId) {
      syncSubagentSessionHeartbeat(this.repo, scope, sessionId, { ownerId: this.ownerId });
    }
    try {
      const result = await task();
      this.repo.updateDelegationJob(scope, jobId, { status: 'completed' });
      this.inbox.publish(scope, runId, jobId, 'result', result);
      if (sessionId) {
        completeSubagentSession(this.repo, scope, sessionId, result.output);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'subagent execution failed';
      this.repo.updateDelegationJob(scope, jobId, {
        status: 'failed',
        lastError: message,
      });
      this.inbox.publish(scope, runId, jobId, 'error', {
        error: message,
      });
      if (sessionId) {
        failSubagentSession(this.repo, scope, sessionId, message);
      }
      throw error;
    }
  }
}
