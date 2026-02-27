import type { MasterRepository } from '@/server/master/repository';
import type { WorkspaceScope } from '@/server/master/types';

export class DelegationInbox {
  constructor(private readonly repo: MasterRepository) {}

  publish(
    scope: WorkspaceScope,
    runId: string,
    jobId: string,
    type: 'progress' | 'result' | 'error',
    payload: unknown,
  ): void {
    this.repo.appendDelegationEvent(scope, {
      runId,
      jobId,
      type,
      payload: JSON.stringify(payload),
    });
  }
}
