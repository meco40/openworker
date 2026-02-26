/**
 * MessageService module entrypoint.
 * Keep this file lean: exports only.
 */

export * from './types';
export { SubagentManager } from './subagentManager';
export { ToolManager } from './toolManager';
export { RecallService } from './recallService';
export { SummaryService } from './summaryService';
export type { CommandHandlerDeps } from './commands';
export { createSendResponse } from './utils/responseHelper';
export { handleMemorySave } from './handlers/memoryHandler';
export { dispatchToAI, runModelToolLoop } from './dispatchers/aiDispatcher';
export { runSubagent, invokeSubagentToolCall } from './subagent/executor';
export { respondToolApproval as execRespondToolApproval } from './approval/handler';
export { MessageService, createMessageService } from './messageService';
