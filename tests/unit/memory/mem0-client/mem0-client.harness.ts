import { afterEach, vi } from 'vitest';
import { __resetMem0ModelHubSyncStateForTests } from '@/server/memory/mem0';
import type { MockProcedure } from '../../../helpers/mockProcedure';

const mem0SyncMocks = vi.hoisted(() => ({
  syncMem0LlmFromModelHub: vi.fn<MockProcedure>(),
  syncMem0EmbedderFromModelHub: vi.fn<MockProcedure>(),
}));

vi.mock('@/server/memory/mem0EmbedderSync', () => ({
  syncMem0LlmFromModelHub: mem0SyncMocks.syncMem0LlmFromModelHub,
  syncMem0EmbedderFromModelHub: mem0SyncMocks.syncMem0EmbedderFromModelHub,
}));

export function getMem0SyncMocks() {
  return mem0SyncMocks;
}

export function registerMem0ClientCleanup(): void {
  afterEach(() => {
    __resetMem0ModelHubSyncStateForTests();
    mem0SyncMocks.syncMem0LlmFromModelHub.mockReset();
    mem0SyncMocks.syncMem0EmbedderFromModelHub.mockReset();
    vi.restoreAllMocks();
  });
}
