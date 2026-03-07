import { getServerEventBus } from '@/server/events/runtime';
import type { MasterInvalidationResource } from '@/server/events/types';
import type { WorkspaceScope } from '@/server/master/types';

interface PublishMasterUpdatedInput {
  scope: Pick<WorkspaceScope, 'userId' | 'workspaceId'>;
  resources: MasterInvalidationResource[];
  runId?: string | null;
  approvalRequestId?: string | null;
  sessionId?: string | null;
  reminderId?: string | null;
}

export function publishMasterUpdated(input: PublishMasterUpdatedInput): void {
  const resources = [...new Set(input.resources)];
  if (resources.length === 0) {
    return;
  }

  getServerEventBus().publish('master.updated', {
    userId: input.scope.userId,
    workspaceId: input.scope.workspaceId,
    resources,
    runId: input.runId ?? null,
    approvalRequestId: input.approvalRequestId ?? null,
    sessionId: input.sessionId ?? null,
    reminderId: input.reminderId ?? null,
    at: new Date().toISOString(),
  });
}
