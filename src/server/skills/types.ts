import type { ChannelType } from '@/shared/domain/types';

export interface SubagentToolCallParams {
  args: Record<string, unknown>;
  conversationId: string;
  userId: string;
  platform: ChannelType;
  externalChatId: string;
}

export interface SkillDispatchContext {
  bypassApproval?: boolean;
  conversationId?: string;
  userId?: string;
  platform?: ChannelType;
  externalChatId?: string;
  invokeSubagentToolCall?: (params: SubagentToolCallParams) => Promise<unknown>;
}

export type SkillHandler = (
  args: Record<string, unknown>,
  context?: SkillDispatchContext,
) => Promise<unknown>;
