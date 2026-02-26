/**
 * Store/add memory operations for Mem0 client
 */

import type { Mem0MemoryInput } from '../types';
import { extractId } from '../utils';

/**
 * Create store memory operation
 */
export function createStoreOperation(
  request: (
    path: string,
    init: { method: 'POST'; body?: Record<string, unknown> },
    options?: { timeoutMs?: number; maxRetries?: number; retryOnTimeout?: boolean },
  ) => Promise<unknown>,
  config: { writeTimeoutMs: number; writeMaxRetries: number },
) {
  return async function addMemory(input: Mem0MemoryInput): Promise<{ id: string | null }> {
    const payload = await request(
      '/memories',
      {
        method: 'POST',
        body: {
          messages: [{ role: 'user', content: input.content }],
          user_id: input.userId,
          agent_id: input.personaId,
          metadata: input.metadata,
          infer: false,
        },
      },
      {
        timeoutMs: config.writeTimeoutMs,
        maxRetries: config.writeMaxRetries,
        retryOnTimeout: true,
      },
    );
    return { id: extractId(payload) };
  };
}

/**
 * Create update memory operation
 */
export function createUpdateOperation(
  request: (
    path: string,
    init: { method: 'PUT'; body?: Record<string, unknown> },
    options?: { timeoutMs?: number; maxRetries?: number; retryOnTimeout?: boolean },
  ) => Promise<unknown>,
  config: { writeTimeoutMs: number; writeMaxRetries: number },
) {
  return async function updateMemory(id: string, input: Mem0MemoryInput): Promise<void> {
    await request(
      `/memories/${encodeURIComponent(id)}`,
      {
        method: 'PUT',
        body: {
          text: input.content,
          metadata: input.metadata,
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
  };
}
