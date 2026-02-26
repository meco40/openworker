/**
 * Configuration and utility methods for MessageService
 * Extracted from the monolithic index.ts
 */

import {
  AUTONOMOUS_BUILD_MAX_TOOL_CALLS,
  SUBAGENT_MAX_ACTIVE_PER_CONVERSATION,
  TOOL_CALLS_HARD_CAP,
} from '../types';

/**
 * Get maximum number of active subagents per conversation
 */
export function getSubagentMaxActivePerConversation(): number {
  const raw = Number.parseInt(String(process.env.SUBAGENT_MAX_ACTIVE || ''), 10);
  if (!Number.isFinite(raw) || raw <= 0) {
    return SUBAGENT_MAX_ACTIVE_PER_CONVERSATION;
  }
  return Math.max(1, Math.min(20, raw));
}

/**
 * Check if interactive tool approval is required
 */
export function requiresInteractiveToolApproval(): boolean {
  return String(process.env.OPENCLAW_EXEC_APPROVALS_REQUIRED || 'false').toLowerCase() === 'true';
}

/**
 * Resolve maximum tool calls for autonomous builds
 */
export function resolveAutonomousBuildMaxToolCalls(): number {
  const raw = Number.parseInt(String(process.env.OPENCLAW_AUTONOMOUS_MAX_TOOL_CALLS || ''), 10);
  if (!Number.isFinite(raw) || raw <= 0) {
    return AUTONOMOUS_BUILD_MAX_TOOL_CALLS;
  }
  return Math.max(AUTONOMOUS_BUILD_MAX_TOOL_CALLS, Math.min(TOOL_CALLS_HARD_CAP, raw));
}

/**
 * Check if code should be allowed in response
 */
export function shouldAllowCodeInResponse(
  userInput: string,
  metadata: Record<string, unknown>,
): boolean {
  const asksForCode =
    /\b(code|source|snippet|beispielcode|zeige code|show code|codeblock|implementation details?)\b/i.test(
      userInput,
    );
  if (asksForCode) return true;

  if (metadata.ok === false) return true;
  const status = String(metadata.status || '');
  if (status.includes('error') || status.includes('failed')) return true;
  return false;
}

/**
 * Strip code blocks from content if needed
 */
export function stripCodeBlocksIfNeeded(content: string, shouldAllowCode: boolean): string {
  const text = String(content || '');
  if (shouldAllowCode) return text;
  if (!text.includes('```')) return text;
  const stripped = text.replace(
    /```[\s\S]*?```/g,
    '[Code weggelassen. Umsetzung wurde im Projekt-Workspace ausgefuehrt.]',
  );
  return stripped.replace(/\n{3,}/g, '\n\n').trim();
}
