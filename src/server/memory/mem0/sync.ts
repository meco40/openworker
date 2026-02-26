/**
 * Model hub synchronization for Mem0 client
 */

import { MEM0_MODEL_HUB_SYNC_COOLDOWN_MS } from './constants';

let mem0ModelHubSyncInFlight: Promise<boolean> | null = null;
let mem0ModelHubLastSyncAttemptMs = 0;

/**
 * Trigger Mem0 model hub synchronization
 */
export async function triggerMem0ModelHubSync(): Promise<boolean> {
  const now = Date.now();
  if (mem0ModelHubSyncInFlight) {
    return mem0ModelHubSyncInFlight;
  }
  if (now - mem0ModelHubLastSyncAttemptMs < MEM0_MODEL_HUB_SYNC_COOLDOWN_MS) {
    return false;
  }
  mem0ModelHubLastSyncAttemptMs = now;
  mem0ModelHubSyncInFlight = (async () => {
    try {
      const syncModule = await import('@/server/memory/mem0EmbedderSync');
      const [llmResult, embedderResult] = await Promise.all([
        syncModule.syncMem0LlmFromModelHub(),
        syncModule.syncMem0EmbedderFromModelHub(),
      ]);
      return llmResult.ok && embedderResult.ok;
    } catch {
      return false;
    } finally {
      mem0ModelHubSyncInFlight = null;
    }
  })();
  return mem0ModelHubSyncInFlight;
}

/**
 * Reset Mem0 model hub sync state (for tests)
 */
export function __resetMem0ModelHubSyncStateForTests(): void {
  mem0ModelHubSyncInFlight = null;
  mem0ModelHubLastSyncAttemptMs = 0;
}
