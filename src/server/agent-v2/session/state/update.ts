/**
 * Session update and retrieval operations.
 */

import { AgentV2Error } from '@/server/agent-v2/errors';
import type { AgentV2Repository } from '@/server/agent-v2/repository';
import type { AgentSessionSnapshot } from '@/server/agent-v2/types';

export interface UpdateSessionContext {
  repository: AgentV2Repository;
  activeHandles: Map<string, { sessionId: string; userId: string; snapshot: AgentSessionSnapshot }>;
}

/**
 * Gets a session by ID, verifying user ownership.
 * Updates the active handles cache.
 */
export function getSession(
  sessionId: string,
  userId: string,
  ctx: UpdateSessionContext,
): AgentSessionSnapshot {
  const session = ctx.repository.getSession(sessionId, userId);
  if (!session) throw new AgentV2Error('Session not found.', 'NOT_FOUND');
  ctx.activeHandles.set(sessionId, { sessionId, userId, snapshot: session });
  return session;
}

/**
 * Lists all sessions for a user with optional limit.
 */
export function listSessions(
  userId: string,
  limit: number,
  repository: AgentV2Repository,
): AgentSessionSnapshot[] {
  return repository.listSessions(userId, limit);
}
