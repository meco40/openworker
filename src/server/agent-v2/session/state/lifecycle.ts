/**
 * Session lifecycle management operations.
 */

import type { AgentV2ExtensionHost } from '@/server/agent-v2/extensions/host';
import type { AgentV2Repository } from '@/server/agent-v2/repository';

export interface LifecycleContext {
  repository: AgentV2Repository;
  extensionHost: AgentV2ExtensionHost;
  processingSessions: Set<string>;
  activeHandles: Map<string, unknown>;
}

/**
 * Performs startup recovery operations.
 * - Marks running commands as failed_recoverable
 * - Prunes expired events
 */
export function performStartupRecovery(ctx: LifecycleContext): void {
  const recovery = ctx.repository.recoverRunningCommandsOnStartup();
  if (recovery.recoveredCommands > 0) {
    console.warn(
      `[agent-v2] Startup recovery marked ${recovery.recoveredCommands} command(s) as failed_recoverable.`,
    );
  }
  ctx.repository.pruneExpiredEvents();
}

/**
 * Closes the session manager and cleans up resources.
 */
export function close(ctx: LifecycleContext): void {
  ctx.extensionHost.stopAll();
  ctx.repository.close();
}

/**
 * Checks if a session is currently being processed.
 */
export function isProcessing(sessionId: string, ctx: LifecycleContext): boolean {
  return ctx.processingSessions.has(sessionId);
}

/**
 * Marks a session as being processed.
 */
export function markProcessing(sessionId: string, ctx: LifecycleContext): void {
  ctx.processingSessions.add(sessionId);
}

/**
 * Unmarks a session from being processed.
 */
export function unmarkProcessing(sessionId: string, ctx: LifecycleContext): void {
  ctx.processingSessions.delete(sessionId);
}
