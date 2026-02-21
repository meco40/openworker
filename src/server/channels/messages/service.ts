// MessageService - Refactored into modular architecture
// This file now re-exports from the service/ directory for backward compatibility

export {
  MessageService,
  createMessageService,
  SubagentManager,
  ToolManager,
  RecallService,
  SummaryService,
} from './service/index';

export type {
  LastRecallState,
  ToolExecutionResult,
  ResolvedToolContext,
  PendingToolApproval,
  KnowledgeRetrievalServiceLike,
  SubagentAction,
  SubagentDispatchContext,
} from './service/types';

export {
  MEMORY_CONTEXT_CHAR_LIMIT,
  MEMORY_RECALL_LIMIT,
  MEMORY_FEEDBACK_WINDOW_MS,
  MODEL_HUB_GATEWAY_PREFIX_RE,
  MAX_TOOL_ROUNDS,
  TOOL_OUTPUT_MAX_CHARS,
  TOOL_APPROVAL_TTL_MS,
  SUBAGENT_RECENT_MINUTES,
  SUBAGENT_DEFAULT_AGENT_ID,
  SUBAGENT_MAX_ACTIVE_PER_CONVERSATION,
  SUBAGENT_RESULT_PREVIEW_MAX_CHARS,
  SUBAGENT_ANNOUNCE_MAX_CHARS,
  extractMemorySaveContent,
  shouldRecallMemoryForInput,
  normalizeMemoryContext,
  detectMemoryFeedbackSignal,
  extractCorrectionContent,
  inferShellCommandFromNaturalLanguage,
} from './service/types';
