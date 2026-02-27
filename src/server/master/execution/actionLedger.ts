import type { MasterRepository } from '@/server/master/repository';
import type { WorkspaceScope } from '@/server/master/types';

export class MasterActionLedgerService {
  constructor(private readonly repo: MasterRepository) {}

  async executeExactlyOnce<T>(input: {
    scope: WorkspaceScope;
    runId: string;
    stepId: string;
    actionType: string;
    idempotencyKey: string;
    execute: () => Promise<T>;
  }): Promise<{ replayed: boolean; result: T }> {
    const existing = this.repo.getActionLedgerByKey(input.scope, input.idempotencyKey);
    if (existing?.state === 'committed' && existing.resultPayload) {
      return {
        replayed: true,
        result: JSON.parse(existing.resultPayload) as T,
      };
    }

    this.repo.upsertActionLedger(input.scope, {
      runId: input.runId,
      stepId: input.stepId,
      actionType: input.actionType,
      idempotencyKey: input.idempotencyKey,
      state: 'started',
      resultPayload: null,
    });

    try {
      const result = await input.execute();
      this.repo.upsertActionLedger(input.scope, {
        runId: input.runId,
        stepId: input.stepId,
        actionType: input.actionType,
        idempotencyKey: input.idempotencyKey,
        state: 'committed',
        resultPayload: JSON.stringify(result),
      });
      return { replayed: false, result };
    } catch (error) {
      this.repo.upsertActionLedger(input.scope, {
        runId: input.runId,
        stepId: input.stepId,
        actionType: input.actionType,
        idempotencyKey: input.idempotencyKey,
        state: 'failed',
        resultPayload: JSON.stringify({
          error: error instanceof Error ? error.message : 'unknown error',
        }),
      });
      throw error;
    }
  }
}
