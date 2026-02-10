import { MemoryService } from './service';
import { SqliteMemoryRepository } from './sqliteMemoryRepository';

declare global {
  var __memoryRepository: SqliteMemoryRepository | undefined;
  var __memoryService: MemoryService | undefined;
}

export function getMemoryRepository(): SqliteMemoryRepository {
  if (!globalThis.__memoryRepository) {
    globalThis.__memoryRepository = new SqliteMemoryRepository();
  }
  return globalThis.__memoryRepository;
}

export function getMemoryService(): MemoryService {
  if (!globalThis.__memoryService) {
    globalThis.__memoryService = new MemoryService(getMemoryRepository());
  }
  return globalThis.__memoryService;
}
