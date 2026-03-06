import type { MasterRepository } from '@/server/master/repository';
import type { WorkspaceScope } from '@/server/master/types';
import { publishDelegationEvent } from '@/server/master/delegation/sessionService';

export class DelegationInbox {
  constructor(private readonly repo: MasterRepository) {}

  publish(
    scope: WorkspaceScope,
    runId: string,
    jobId: string,
    type: 'progress' | 'result' | 'error',
    payload: unknown,
  ): void {
    publishDelegationEvent(this.repo, scope, {
      runId,
      jobId,
      type,
      payload: JSON.stringify(payload),
    });
  }
}
