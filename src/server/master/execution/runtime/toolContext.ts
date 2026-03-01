import { ChannelType } from '@/shared/domain/types';
import type { MasterWorkspaceBinding } from '@/server/master/workspaceScope';

export function buildToolContext(
  scope: MasterWorkspaceBinding,
  runId: string,
  bypassApproval = false,
) {
  return {
    bypassApproval,
    workspaceCwd: scope.workspaceCwd,
    conversationId: `master:${runId}`,
    userId: scope.userId,
    platform: ChannelType.WEBCHAT,
    externalChatId: `master:${scope.workspaceId}`,
  } as const;
}
