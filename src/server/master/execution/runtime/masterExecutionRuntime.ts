import { executeMasterRunFlow } from '@/server/master/execution/runtime/executionFlow';
import { parseJsonObject } from '@/server/master/execution/runtime/jsonParsing';
import type { MasterRunExportBundle, RuntimeMode } from '@/server/master/execution/runtime/types';
import type { MasterOrchestrator } from '@/server/master/orchestrator';
import type { MasterRepository } from '@/server/master/repository';
import type { WorkspaceScope } from '@/server/master/types';
import type { MasterWorkspaceBinding } from '@/server/master/workspaceScope';
import type { VerificationReport } from '@/server/master/verification';

export type { MasterRunExportBundle };

export class MasterExecutionRuntime {
  private readonly running = new Map<string, Promise<void>>();
  private readonly ownerId = `master-runtime-${Math.random().toString(36).slice(2)}`;

  constructor(
    private readonly repo: MasterRepository,
    private readonly orchestrator: MasterOrchestrator,
  ) {}

  isRunning(scope: WorkspaceScope, runId: string): boolean {
    return this.running.has(this.key(scope, runId));
  }

  startBackground(scope: MasterWorkspaceBinding, runId: string): boolean {
    const key = this.key(scope, runId);
    if (this.running.has(key)) return false;
    const leaseExpiresAt = new Date(Date.now() + 60_000).toISOString();
    const claimed = this.repo.claimRun(scope, runId, this.ownerId, leaseExpiresAt);
    if (!claimed) return false;
    const promise = this.execute(scope, runId).finally(() => {
      this.repo.releaseRunLease(scope, runId, this.ownerId);
      this.running.delete(key);
    });
    this.running.set(key, promise);
    return true;
  }

  async executeNow(scope: MasterWorkspaceBinding, runId: string) {
    const leaseExpiresAt = new Date(Date.now() + 60_000).toISOString();
    if (!this.repo.claimRun(scope, runId, this.ownerId, leaseExpiresAt)) {
      throw new Error('Master run is already claimed by another runtime.');
    }
    try {
      await this.execute(scope, runId);
    } finally {
      this.repo.releaseRunLease(scope, runId, this.ownerId);
    }
    const run = this.repo.getRun(scope, runId);
    if (!run) {
      throw new Error('Master run not found.');
    }
    return run;
  }

  async waitForRun(scope: WorkspaceScope, runId: string): Promise<void> {
    const key = this.key(scope, runId);
    const pending = this.running.get(key);
    if (pending) {
      await pending;
    }
  }

  buildExportBundle(scope: WorkspaceScope, runId: string): MasterRunExportBundle {
    const run = this.repo.getRun(scope, runId);
    if (!run) {
      throw new Error('Run not found');
    }
    const steps = this.repo.listSteps(scope, runId).map((step) => ({ ...step }));
    const jobs = this.repo.listDelegationJobs(scope, runId).map((job) => ({ ...job }));
    const events = this.repo.listDelegationEvents(scope, runId).map((event) => ({ ...event }));
    const parsedBundle = run.resultBundle ? parseJsonObject(run.resultBundle) : null;
    return {
      runId,
      status: run.status,
      run,
      steps,
      delegations: { jobs, events },
      verificationReport: (parsedBundle?.verificationReport as VerificationReport) || null,
      executionMode:
        parsedBundle?.executionMode === 'model' || parsedBundle?.executionMode === 'fallback'
          ? (parsedBundle.executionMode as RuntimeMode)
          : null,
      exportedAt: new Date().toISOString(),
    };
  }

  private key(scope: WorkspaceScope, runId: string): string {
    return `${scope.userId}::${scope.workspaceId}::${runId}`;
  }

  private nextStepSequence(scope: MasterWorkspaceBinding, runId: string): number {
    const steps = this.repo.listSteps(scope, runId);
    if (!steps.length) return 1;
    return Math.max(...steps.map((step) => step.seq)) + 1;
  }

  private async execute(scope: MasterWorkspaceBinding, runId: string): Promise<void> {
    const renewLease = () =>
      this.repo.renewRunLease(
        scope,
        runId,
        this.ownerId,
        new Date(Date.now() + 60_000).toISOString(),
        new Date().toISOString(),
      );

    renewLease();
    const heartbeat = setInterval(() => {
      renewLease();
    }, 15_000);
    heartbeat.unref?.();
    try {
      await executeMasterRunFlow({
        scope,
        runId,
        repo: this.repo,
        orchestrator: this.orchestrator,
        nextStepSequence: (flowScope, flowRunId) => this.nextStepSequence(flowScope, flowRunId),
      });
    } finally {
      clearInterval(heartbeat);
    }
  }
}
