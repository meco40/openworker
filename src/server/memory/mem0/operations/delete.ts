/**
 * Delete memory operations for Mem0 client
 */

import { extractDeletedCount } from '../utils';
import { isLegacyDeleteFilterError } from '../utils/http';

/**
 * Create delete memory operation
 */
export function createDeleteOperation(
  request: (
    path: string,
    init: { method: 'DELETE'; body?: Record<string, unknown> },
    options?: { timeoutMs?: number; maxRetries?: number; retryOnTimeout?: boolean },
  ) => Promise<unknown>,
  config: { writeTimeoutMs: number; writeMaxRetries: number },
) {
  return async function deleteMemory(id: string): Promise<void> {
    await request(
      `/memories/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
      {
        timeoutMs: config.writeTimeoutMs,
        maxRetries: config.writeMaxRetries,
        retryOnTimeout: true,
      },
    );
  };
}

/**
 * Create delete memories by filter operation
 */
export function createDeleteByFilterOperation(
  request: (
    path: string,
    init: { method: 'DELETE'; body?: Record<string, unknown> },
    options?: { timeoutMs?: number; maxRetries?: number; retryOnTimeout?: boolean },
  ) => Promise<unknown>,
  config: { writeTimeoutMs: number; writeMaxRetries: number },
) {
  return async function deleteMemoriesByFilter(input: {
    userId: string;
    personaId: string;
  }): Promise<number> {
    try {
      const payload = await request(
        '/memories',
        {
          method: 'DELETE',
          body: {
            user_id: input.userId,
            agent_id: input.personaId,
          },
        },
        {
          timeoutMs: config.writeTimeoutMs,
          maxRetries: config.writeMaxRetries,
          retryOnTimeout: true,
        },
      );
      return extractDeletedCount(payload);
    } catch (error) {
      if (!isLegacyDeleteFilterError(error)) throw error;
    }

    const params = new URLSearchParams({
      user_id: input.userId,
      agent_id: input.personaId,
    });
    const fallbackPayload = await request(
      `/memories?${params.toString()}`,
      {
        method: 'DELETE',
      },
      {
        timeoutMs: config.writeTimeoutMs,
        maxRetries: config.writeMaxRetries,
        retryOnTimeout: true,
      },
    );
    return extractDeletedCount(fallbackPayload);
  };
}
