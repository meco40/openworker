import type { Conversation } from '@/server/channels/messages/repository';
import type { ChannelType } from '@/shared/domain/types';
import type { SubagentRunRecord } from '@/server/agents/subagentRegistry';
import { countActiveSubagentRuns, createSubagentRun } from '@/server/agents/subagentRegistry';
import { resolveSubagentAgentProfile } from '@/server/channels/messages/service/subagent/agentProfiles';

export interface StartSubagentRunParams {
  conversation: Conversation;
  platform: ChannelType;
  externalChatId: string;
  agentId: string;
  task: string;
  guidance?: string;
  modelOverride?: string;
}

export interface StartSubagentRunOptions {
  getSubagentMaxActivePerConversation: () => number;
  resolveConversationWorkspace?: (conversation: Conversation) => {
    projectId?: string;
    workspacePath?: string;
    workspaceRelativePath?: string;
  } | null;
}

export async function startSubagentRun(
  params: StartSubagentRunParams,
  options: StartSubagentRunOptions,
): Promise<SubagentRunRecord> {
  const active = countActiveSubagentRuns(params.conversation.id);
  const maxActive = options.getSubagentMaxActivePerConversation();
  if (active >= maxActive) {
    throw new Error(`Subagent limit reached (${active}/${maxActive}).`);
  }

  const workspace = options.resolveConversationWorkspace?.(params.conversation) || null;
  const projectId = workspace?.projectId;
  const workspacePath = workspace?.workspacePath;
  const workspaceRelativePath = workspace?.workspaceRelativePath;
  const profile = resolveSubagentAgentProfile(params.agentId);
  const mergedGuidance = [profile?.defaultGuidance, params.guidance]
    .map((entry) => String(entry || '').trim())
    .filter(Boolean)
    .join('\n\n');

  const run = createSubagentRun({
    requesterConversationId: params.conversation.id,
    requesterUserId: params.conversation.userId,
    agentId: params.agentId,
    task: params.task,
    guidance: mergedGuidance || undefined,
    modelOverride: params.modelOverride,
    projectId,
    workspacePath,
    workspaceRelativePath,
    profileId: profile?.id,
    profileName: profile?.name,
    skillIds: profile?.skillIds,
    toolFunctionNames: profile?.toolFunctionNames,
  });

  return run;
}
