import type { ChannelType } from '@/shared/domain/types';
import type { Conversation } from '@/server/channels/messages/repository';

export type DispatchMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export interface ToolContextState {
  tools: unknown[];
  installedFunctionNames: Set<string>;
  functionToSkillId: Map<string, string>;
}

export interface ModelOutcome {
  content: string;
  metadata: Record<string, unknown>;
}

export interface RunModelToolLoopParams {
  conversation: Conversation;
  messages: DispatchMessage[];
  modelHubProfileId: string;
  preferredModelId?: string;
  workspaceCwd?: string;
  toolContext: ToolContextState;
  maxToolCalls?: number;
  abortSignal?: AbortSignal;
  onStreamDelta?: (delta: string) => void;
  auditContextExtras?: { turnSeq?: number; memoryContext?: string };
}

export interface DispatchToAIParams {
  conversation: Conversation;
  platform: ChannelType;
  externalChatId: string;
  userInput: string;
  onStreamDelta?: (delta: string) => void;
  turnSeq?: number;
  executionDirective?: string;
  maxToolCalls?: number;
  skipSummaryRefresh?: boolean;
  requireToolCall?: boolean;
  toolsDisabled?: boolean;
}
