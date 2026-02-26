/**
 * Command Handlers - Backward Compatibility Re-export
 *
 * This file now re-exports from the modularized command handlers.
 * The actual implementation has been moved to:
 *   src/server/channels/messages/service/commands/
 *
 * Original file backed up to:
 *   backups/modularization-prio1-20260226-1838/commandHandlers.ts.bak
 */

// Re-export all command handlers from the new module location
export {
  // Types
  type CommandHandlerDeps,
  type SubagentDispatchContext,
  // Command handlers
  handleAutomationCommand,
  handleShellCommand,
  handleApprovalCommand,
  handleSubagentCommand,
  handlePersonaCommand,
  handleProjectCommand,
  handleMemorySave,
} from './commands';
