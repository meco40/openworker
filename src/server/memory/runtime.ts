import { MemoryService } from './service';
import type { Mem0Client } from './mem0Client';
import { createMem0ClientFromEnv } from './mem0Client';
import { SqliteMemoryRepository } from './sqliteMemoryRepository';

declare global {
  var __memoryRepository: SqliteMemoryRepository | undefined;
  var __memoryService: MemoryService | undefined;
  var __mem0Client: Mem0Client | null | undefined;
}

export function getMemoryRepository(): SqliteMemoryRepository {
  if (!globalThis.__memoryRepository) {
    globalThis.__memoryRepository = new SqliteMemoryRepository();
  }
  return globalThis.__memoryRepository;
}

export function getMemoryService(): MemoryService {
  if (globalThis.__mem0Client === undefined) {
    globalThis.__mem0Client = createMem0ClientFromEnv();
  }
  if (!globalThis.__memoryService) {
    globalThis.__memoryService = new MemoryService(
      getMemoryRepository(),
      undefined,
      globalThis.__mem0Client || undefined,
    );
  }
  return globalThis.__memoryService;
}

export function getMemoryProviderKind(): 'sqlite' | 'mem0' {
  if (globalThis.__mem0Client === undefined) {
    globalThis.__mem0Client = createMem0ClientFromEnv();
  }
  return globalThis.__mem0Client ? 'mem0' : 'sqlite';
}
