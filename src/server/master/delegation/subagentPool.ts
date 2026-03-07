import type { MasterRepository } from '@/server/master/repository';
import type { WorkspaceScope } from '@/server/master/types';
import { DelegationInbox } from '@/server/master/delegation/inbox';
import { publishMasterUpdated } from '@/server/master/liveEvents';
import {
  claimSubagentSession,
  completeSubagentSession,
  failSubagentSession,
  syncSubagentSessionHeartbeat,
} from '@/server/master/delegation/sessionService';

interface SubagentPoolOptions {
  heartbeatIntervalMs?: number;
  leaseMs?: number;
}

export class SubagentPool {
  private readonly ownerId = `subagent-pool:${process.pid}`;

  constructor(
    private readonly repo: MasterRepository,
    private readonly inbox: DelegationInbox,
    private readonly options: SubagentPoolOptions = {},
  ) {}

  async execute(
    scope: WorkspaceScope,
    runId: string,
    jobId: string,
    sessionId: string | null,
    task: () => Promise<{ output: string; confidence?: number }>,
  ): Promise<void> {
    const leaseMs = this.options.leaseMs ?? 30_000;
    const heartbeatIntervalMs = this.options.heartbeatIntervalMs ?? 10_000;
    const publishState = () =>
      publishMasterUpdated({
        scope,
        resources: sessionId ? ['subagents', 'metrics'] : ['metrics'],
        runId,
        sessionId,
      });
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    const syncHeartbeat = () => {
      if (!sessionId) return;
      const updated = syncSubagentSessionHeartbeat(this.repo, scope, sessionId, {
        ownerId: this.ownerId,
        leaseMs,
      });
      if (!updated && heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    };

    if (sessionId) {
      claimSubagentSession(this.repo, scope, sessionId, { ownerId: this.ownerId, leaseMs });
    }
    this.repo.updateDelegationJob(scope, jobId, { status: 'running' });
    publishState();
    this.inbox.publish(scope, runId, jobId, 'progress', { stage: 'running' });
    if (sessionId) {
      syncHeartbeat();
      heartbeatTimer = setInterval(syncHeartbeat, heartbeatIntervalMs);
      heartbeatTimer.unref?.();
    }
    try {
      const result = await task();
      const session = sessionId ? this.repo.getSubagentSession(scope, sessionId) : null;
      if (session?.status === 'cancelled') {
        this.repo.updateDelegationJob(scope, jobId, { status: 'cancelled' });
        publishState();
        return;
      }
      this.repo.updateDelegationJob(scope, jobId, { status: 'completed' });
      publishState();
      this.inbox.publish(scope, runId, jobId, 'result', result);
      if (sessionId) {
        completeSubagentSession(this.repo, scope, sessionId, result.output);
      }
    } catch (error) {
      const session = sessionId ? this.repo.getSubagentSession(scope, sessionId) : null;
      if (session?.status === 'cancelled') {
        this.repo.updateDelegationJob(scope, jobId, { status: 'cancelled' });
        publishState();
        return;
      }
      const message = error instanceof Error ? error.message : 'subagent execution failed';
      this.repo.updateDelegationJob(scope, jobId, {
        status: 'failed',
        lastError: message,
      });
      publishState();
      this.inbox.publish(scope, runId, jobId, 'error', {
        error: message,
      });
      if (sessionId) {
        failSubagentSession(this.repo, scope, sessionId, message);
      }
      throw error;
    } finally {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
      }
    }
  }
}
