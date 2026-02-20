import { ProactiveGateService } from '@/server/proactive/service';
import { SqliteProactiveRepository } from '@/server/proactive/sqliteProactiveRepository';

declare global {
  var __proactiveRepository: SqliteProactiveRepository | undefined;
  var __proactiveGateService: ProactiveGateService | undefined;
}

export function getProactiveRepository(): SqliteProactiveRepository {
  if (!globalThis.__proactiveRepository) {
    globalThis.__proactiveRepository = new SqliteProactiveRepository();
  }
  return globalThis.__proactiveRepository;
}

export function getProactiveGateService(): ProactiveGateService {
  if (!globalThis.__proactiveGateService) {
    globalThis.__proactiveGateService = new ProactiveGateService(getProactiveRepository());
  }
  return globalThis.__proactiveGateService;
}
