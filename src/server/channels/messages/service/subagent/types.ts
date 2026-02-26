import type { ChannelType } from '@/shared/domain/types';
import type { Conversation } from '@/server/channels/messages/repository';
import type { SubagentRunRecord } from '@/server/agents/subagentRegistry';
import type { SubagentAction, SubagentDispatchContext, ResolvedToolContext } from '../types';

export interface SubagentManagerDeps {
  startSubagentRun: (params: {
    conversation: Conversation;
    platform: ChannelType;
    externalChatId: string;
    agentId: string;
    task: string;
    guidance?: string;
    modelOverride?: string;
  }) => Promise<SubagentRunRecord>;
  runSubagent: (params: {
    conversation: Conversation;
    platform: ChannelType;
    externalChatId: string;
    run: SubagentRunRecord;
  }) => Promise<void>;
  sendResponse: (
    conversation: Conversation,
    content: string,
    platform: ChannelType,
    externalChatId: string,
    metadata?: Record<string, unknown>,
  ) => Promise<unknown>;
}

export interface ParsedSubagentAction {
  action: SubagentAction;
  args: string[];
}

export interface SpawnInputResult {
  agentId: string;
  task: string;
  modelOverride?: string;
  error?: string;
}

export interface SubagentTargetResult {
  run: SubagentRunRecord | null;
  error?: string;
}

export interface ActionResult {
  text: string;
  payload?: Record<string, unknown>;
}

export type {
  ChannelType,
  Conversation,
  SubagentRunRecord,
  SubagentAction,
  SubagentDispatchContext,
  ResolvedToolContext,
};
