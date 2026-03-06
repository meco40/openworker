import type { MasterRepository } from '@/server/master/repository';
import type { WorkspaceScope } from '@/server/master/types';
import { DelegationInbox } from '@/server/master/delegation/inbox';
import { DelegationResourceGovernor } from '@/server/master/delegation/resourceGovernor';
import { evaluateTriggerPolicy } from '@/server/master/delegation/triggerPolicy';
import {
  createSubagentSessionForDispatch,
  publishDelegationEvent,
} from '@/server/master/delegation/sessionService';
import { SubagentPool } from '@/server/master/delegation/subagentPool';
import { isMasterSubagentSessionsEnabled } from '@/server/master/featureFlags';

export class DelegationDispatcher {
  private readonly inbox: DelegationInbox;
  private readonly pool: SubagentPool;
  private readonly governor: DelegationResourceGovernor;

  constructor(
    private readonly repo: MasterRepository,
    options?: { maxConcurrent?: number },
  ) {
    this.inbox = new DelegationInbox(repo);
    this.pool = new SubagentPool(repo, this.inbox);
    this.governor = new DelegationResourceGovernor(options?.maxConcurrent ?? 4);
  }

  async dispatch(input: {
    scope: WorkspaceScope;
    runId: string;
    capability: string;
    payload: string;
    timeoutMs?: number;
    task: () => Promise<{ output: string; confidence?: number }>;
  }): Promise<{ jobId: string; accepted: boolean; reason?: string }> {
    const timeoutMs = input.timeoutMs ?? 120_000;
    const cooldownMsRaw = Number(process.env.MASTER_DELEGATION_COOLDOWN_MS || 1500);
    const cooldownMs = Number.isFinite(cooldownMsRaw) && cooldownMsRaw >= 0 ? cooldownMsRaw : 1500;
    const policy = evaluateTriggerPolicy({
      scopeKey: `${input.scope.userId}::${input.scope.workspaceId}`,
      capability: input.capability,
      now: Date.now(),
      timeoutMs,
      cooldownMs,
      maxConcurrent: 4,
      activeForCapability: this.governor.getActiveForCapability(input.capability),
      activeGlobal: this.governor.getActiveGlobal(),
    });
    if (!policy.allowed) {
      return { jobId: '', accepted: false, reason: policy.reason };
    }
    if (!this.governor.tryAcquire(input.capability)) {
      return { jobId: '', accepted: false, reason: 'capacity_exhausted' };
    }

    const session = isMasterSubagentSessionsEnabled()
      ? createSubagentSessionForDispatch(this.repo, input.scope, {
          runId: input.runId,
          capability: input.capability,
          payload: input.payload,
        })
      : null;
    const job = this.repo.createDelegationJob(input.scope, {
      runId: input.runId,
      capability: input.capability,
      payload: input.payload,
      status: 'queued',
      priority: 'medium',
      maxAttempts: 3,
      timeoutMs,
    });
    publishDelegationEvent(this.repo, input.scope, {
      runId: input.runId,
      jobId: job.id,
      type: 'created',
      payload: JSON.stringify({ capability: input.capability }),
    });

    try {
      await this.pool.execute(input.scope, input.runId, job.id, session?.id ?? null, input.task);
      return { jobId: job.id, accepted: true };
    } finally {
      this.governor.release(input.capability);
    }
  }
}
