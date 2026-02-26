/**
 * Command Handlers Module
 *
 * This module exports all command handlers for the message service.
 * Reorganized from monolithic commandHandlers.ts (829 lines) to modular structure.
 */

// Types
export type { CommandHandlerDeps } from './types';
export type { SubagentDispatchContext } from '../types';

// Command handlers
export { handleAutomationCommand } from './automationCommand';
export { handleShellCommand } from './shellCommand';
export { handleApprovalCommand } from './approvalCommand';
export { handleSubagentCommand } from './subagentCommand';
export { handlePersonaCommand } from './personaCommand';
export { handleProjectCommand } from './projectCommand';
export { handleMemorySave } from './memoryCommand';
