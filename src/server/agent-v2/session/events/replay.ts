/**
 * Event replay and retrieval operations.
 */

import type { AgentV2Repository } from '@/server/agent-v2/repository';
import type { AgentV2EventEnvelope } from '@/server/agent-v2/types';

export interface ReplayContext {
  repository: AgentV2Repository;
}

/**
 * Replays session events from a specific sequence number.
 */
export function replaySessionEvents(
  input: {
    sessionId: string;
    userId: string;
    fromSeq: number;
    limit?: number;
  },
  ctx: ReplayContext,
): AgentV2EventEnvelope[] {
  return ctx.repository.replayEvents(input);
}

/**
 * Gets the terminal event (completed or error) for a specific command.
 * Bypasses seq-based replay, works even when lastSeq is stale.
 */
export function getCommandResult(
  commandId: string,
  sessionId: string,
  repository: AgentV2Repository,
): AgentV2EventEnvelope | null {
  return repository.getCommandResult(commandId, sessionId);
}
