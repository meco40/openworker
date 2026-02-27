import type { MasterRepository } from '@/server/master/repository';
import type { ApprovalDecision, MasterRun, WorkspaceScope } from '@/server/master/types';
import { assertTransition, nextLifecycleStatus } from '@/server/master/lifecycle';
import { DelegationDispatcher } from '@/server/master/delegation/dispatcher';
import { MasterActionLedgerService } from '@/server/master/execution/actionLedger';
import { buildIdempotencyKey } from '@/server/master/execution/idempotency';

export class MasterOrchestrator {
  private readonly dispatcher: DelegationDispatcher;
  private readonly ledger: MasterActionLedgerService;

  constructor(private readonly repo: MasterRepository) {
    this.dispatcher = new DelegationDispatcher(repo);
    this.ledger = new MasterActionLedgerService(repo);
  }

  getRun(scope: WorkspaceScope, runId: string): MasterRun | null {
    return this.repo.getRun(scope, runId);
  }

  advanceRun(
    scope: WorkspaceScope,
    runId: string,
    options?: {
      verificationPassed?: boolean;
      needsApproval?: boolean;
      failed?: boolean;
      progress?: number;
    },
  ): MasterRun {
    const run = this.repo.getRun(scope, runId);
    if (!run) throw new Error('Master run not found.');
    const next = nextLifecycleStatus(run.status, options);
    if (next !== run.status) {
      assertTransition(run.status, next);
    }
    const progress = Math.min(
      100,
      Math.max(0, options?.progress ?? run.progress + (next === 'COMPLETED' ? 100 : 15)),
    );
    return this.repo.updateRun(scope, runId, {
      status: next,
      progress,
      pausedForApproval: next === 'AWAITING_APPROVAL',
    })!;
  }

  applyApprovalDecision(
    scope: WorkspaceScope,
    runId: string,
    input: { actionType: string; fingerprint: string; decision: ApprovalDecision },
  ): MasterRun {
    if (input.decision === 'approve_always') {
      this.repo.upsertApprovalRule(scope, input.actionType, input.fingerprint, 'approve_always');
    }
    if (input.decision === 'deny') {
      return this.repo.updateRun(scope, runId, {
        status: 'REFINING',
        pausedForApproval: false,
        lastError: `Action denied: ${input.actionType}`,
      })!;
    }
    return this.repo.updateRun(scope, runId, {
      status: 'EXECUTING',
      pausedForApproval: false,
      lastError: null,
    })!;
  }

  async delegate(
    scope: WorkspaceScope,
    runId: string,
    input: {
      capability: string;
      payload: string;
      task: () => Promise<{ output: string; confidence?: number }>;
    },
  ): Promise<{ jobId: string; accepted: boolean; reason?: string }> {
    return this.dispatcher.dispatch({
      scope,
      runId,
      capability: input.capability,
      payload: input.payload,
      task: input.task,
    });
  }

  async executeSideEffect<T>(input: {
    scope: WorkspaceScope;
    runId: string;
    stepId: string;
    actionType: string;
    payload: string;
    execute: () => Promise<T>;
  }): Promise<{ replayed: boolean; result: T }> {
    const idempotencyKey = buildIdempotencyKey({
      runId: input.runId,
      stepId: input.stepId,
      actionType: input.actionType,
      actionPayload: input.payload,
    });
    return this.ledger.executeExactlyOnce({
      scope: input.scope,
      runId: input.runId,
      stepId: input.stepId,
      actionType: input.actionType,
      idempotencyKey,
      execute: input.execute,
    });
  }
}
