/**
 * Transcript Repair — fixes orphaned tool calls in the message history.
 *
 * When a conversation is resumed after a crash, timeout, or abort, the message
 * history may contain "assistant" tool-call stubs that were never answered.
 *
 * Example orphan:
 *   { role: 'assistant', content: '[Tool call: shell_execute]' }   ← no matching result
 *
 * Without repair the model sees an incomplete exchange and may:
 *   - Repeat the same tool call infinitely
 *   - Refuse to continue because the context is malformed
 *   - Hallucinate a result
 *
 * This module scans the messages array and injects synthetic error results for
 * every unmatched tool-call stub, making the transcript consistent before the
 * model sees it.
 */

import type { GatewayMessage } from '@/server/model-hub/Models/types';

/** Pattern: [Tool call: <name>] */
const TOOL_CALL_STUB_RE = /^\[Tool call: ([^\]]+)\]$/;

/** Pattern: Tool "<name>" result:  OR  Tool "<name>" failed: */
const TOOL_RESULT_PREFIX_RE = /^Tool "([^"]+)" (?:result|failed):/;

/**
 * Scan `messages` for orphaned tool-call stubs and insert a synthetic failure
 * result after each one.  Returns a new array (does not mutate in place).
 *
 * Idempotent: calling this twice on already-repaired history is safe.
 */
export function repairOrphanedToolCalls(messages: GatewayMessage[]): GatewayMessage[] {
  const output: GatewayMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg) continue;
    output.push(msg);

    // Only inspect assistant messages that look like tool-call stubs
    if (msg.role !== 'assistant') continue;
    const stubMatch = TOOL_CALL_STUB_RE.exec(msg.content.trim());
    if (!stubMatch) continue;
    const toolName = stubMatch[1];
    if (!toolName) continue;

    // Check whether the NEXT user message is the matching tool result
    const next = messages[i + 1];
    const isAnswered =
      next &&
      next.role === 'user' &&
      (() => {
        const m = TOOL_RESULT_PREFIX_RE.exec(next.content);
        return m !== null && m[1] === toolName;
      })();

    if (!isAnswered) {
      // Inject synthetic failure result so the transcript is consistent
      output.push({
        role: 'user',
        content:
          `Tool "${toolName}" failed:\n` +
          `[System: Tool result was lost — the session was interrupted or the call timed out. ` +
          `Do NOT repeat the same tool call. Re-evaluate your plan and continue with the ` +
          `information you already have, or choose a different approach.]`,
      });
    }
  }

  return output;
}

/**
 * Count the number of orphaned tool-call stubs in a messages array.
 * Useful for logging/metrics.
 */
export function countOrphanedToolCalls(messages: GatewayMessage[]): number {
  let count = 0;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg || msg.role !== 'assistant') continue;
    const stubMatch = TOOL_CALL_STUB_RE.exec(msg.content.trim());
    if (!stubMatch) continue;
    const toolName = stubMatch[1];
    if (!toolName) continue;
    const next = messages[i + 1];
    const isAnswered =
      next &&
      next.role === 'user' &&
      (() => {
        const m = TOOL_RESULT_PREFIX_RE.exec(next.content);
        return m !== null && m[1] === toolName;
      })();
    if (!isAnswered) count += 1;
  }
  return count;
}
