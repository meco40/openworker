/**
 * Core types for MessageService
 * Extracted from the monolithic index.ts
 */

import type { ChannelType } from '@/shared/domain/types';
import type { HistoryManager } from '@/server/channels/messages/historyManager';
import type { ContextBuilder } from '@/server/channels/messages/contextBuilder';
import type { SubagentManager } from '@/server/channels/messages/service/subagentManager';
import type { ToolManager } from '@/server/channels/messages/service/toolManager';
import type { RecallService } from '@/server/channels/messages/service/recallService';
import type { SummaryService } from '@/server/channels/messages/service/summaryService';
import type { SessionManager } from '@/server/channels/messages/sessionManager';

// Re-export CommandHandlerDeps from commands/types for consistency
export type { CommandHandlerDeps } from '@/server/channels/messages/service/commands/types';

/**
 * Service state container for shared state between modules
 */
export interface ServiceState {
  activeRequests: Map<string, AbortController>;
  processingMessages: Set<string>;
  pendingProjectClarifications: Map<
    string,
    {
      requestedAt: string;
      originalTask: string;
      platform: ChannelType;
      externalChatId: string;
    }
  >;
}

/**
 * Core service components
 */
export interface ServiceComponents {
  sessionManager: SessionManager;
  historyManager: HistoryManager;
  contextBuilder: ContextBuilder;
  subagentManager: SubagentManager;
  toolManager: ToolManager;
  recallService: RecallService;
  summaryService: SummaryService;
  summaryRefreshInFlight: Set<string>;
}

/**
 * Tool execution result types
 */
export type ToolExecutionResult =
  | { kind: 'summary'; text: string }
  | {
      kind: 'approval_required';
      message: import('@/server/channels/messages/repository').StoredMessage;
    };

/**
 * Model routing configuration
 */
export interface ModelRoutingConfig {
  preferredModelId?: string;
  modelHubProfileId: string;
}
