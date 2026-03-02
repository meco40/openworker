import type { DebugConversationSummary } from '@/shared/domain/types';

export type PromptDispatchKind =
  | 'chat'
  | 'summary'
  | 'worker_planner'
  | 'worker_executor'
  | 'api_gateway'
  | 'orchestra_routing'
  | 'room'
  | 'knowledge-extraction';

export type PromptTokensSource = 'exact' | 'estimated';
export type PromptDispatchStatus = 'success' | 'error';
export type PromptDispatchRiskLevel = 'low' | 'medium' | 'high';

export interface PromptDispatchEntry {
  id: string;
  providerId: string;
  modelName: string;
  accountId: string | null;
  dispatchKind: PromptDispatchKind;
  promptTokens: number;
  promptTokensSource: PromptTokensSource;
  completionTokens: number;
  totalTokens: number;
  status: PromptDispatchStatus;
  errorMessage: string | null;
  riskLevel: PromptDispatchRiskLevel;
  riskScore: number;
  riskReasons: string[];
  promptPreview: string;
  promptPayloadJson: string;
  promptCostUsd: number | null;
  completionCostUsd: number | null;
  totalCostUsd: number | null;
  createdAt: string;
  conversationId: string | null;
  turnSeq: number | null;
  latencyMs: number | null;
  toolCallsJson: string;
  memoryContextJson: string | null;
}

export interface PromptDispatchFilter {
  from?: string;
  to?: string;
  search?: string;
  provider?: string;
  model?: string;
  risk?: PromptDispatchRiskLevel | 'flagged';
  limit?: number;
  before?: string;
  beforeTurnSeq?: number;
  conversationId?: string;
}

export interface PromptDispatchSummary {
  totalEntries: number;
  flaggedEntries: number;
  promptTokensTotal: number;
  promptTokensExactCount: number;
  promptTokensEstimatedCount: number;
  totalCostUsd: number;
}

export interface RecordPromptDispatchInput {
  providerId: string;
  modelName: string;
  accountId: string | null;
  dispatchKind: PromptDispatchKind;
  promptTokens: number;
  promptTokensSource: PromptTokensSource;
  completionTokens: number;
  totalTokens: number;
  status: PromptDispatchStatus;
  errorMessage: string | null;
  riskLevel: PromptDispatchRiskLevel;
  riskScore: number;
  riskReasons: string[];
  promptPreview: string;
  promptPayloadJson: string;
  promptCostUsd?: number | null;
  completionCostUsd?: number | null;
  totalCostUsd?: number | null;
  createdAt?: string;
  conversationId?: string | null;
  turnSeq?: number | null;
  latencyMs?: number | null;
  toolCallsJson?: string;
  memoryContextJson?: string | null;
}

export type PromptDispatchConversationSummary = DebugConversationSummary;
