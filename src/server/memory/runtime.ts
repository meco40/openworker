import { MemoryService } from './service';
import type { Mem0Client } from './mem0Client';
import { createMem0ClientFromEnv } from './mem0Client';

declare global {
  var __memoryService: MemoryService | undefined;
  var __mem0Client: Mem0Client | null | undefined;
}

type EnvLike = Record<string, string | undefined>;

export function assertMemoryRuntimeConfiguration(env: EnvLike = process.env as EnvLike): void {
  const nodeEnv = String(env.NODE_ENV || '').trim().toLowerCase();
  if (nodeEnv !== 'production') return;

  const provider = String(env.MEMORY_PROVIDER || '').trim().toLowerCase();
  if (provider !== 'mem0') {
    throw new Error('Invalid memory configuration: production requires MEMORY_PROVIDER=mem0.');
  }

  const baseUrl = String(env.MEM0_BASE_URL || '').trim();
  if (!baseUrl) {
    throw new Error('Invalid memory configuration: MEM0_BASE_URL is required when MEMORY_PROVIDER=mem0.');
  }
}

function resolveMem0Client(): Mem0Client | null {
  assertMemoryRuntimeConfiguration();
  if (globalThis.__mem0Client === undefined) {
    globalThis.__mem0Client = createMem0ClientFromEnv();
  }
  return globalThis.__mem0Client ?? null;
}

function getRequiredMem0Client(): Mem0Client {
  const client = resolveMem0Client();
  if (!client) {
    throw new Error(
      'Invalid memory configuration: Mem0 client unavailable. Set MEMORY_PROVIDER=mem0 and MEM0_BASE_URL.',
    );
  }
  return client;
}

export function getMemoryService(): MemoryService {
  if (!globalThis.__memoryService) {
    globalThis.__memoryService = new MemoryService(getRequiredMem0Client());
  }
  return globalThis.__memoryService;
}

export function getMemoryProviderKind(): 'mem0' {
  getRequiredMem0Client();
  return 'mem0';
}
