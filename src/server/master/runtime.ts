import { SqliteMasterRepository } from '@/server/master/sqliteMasterRepository';
import { MasterOrchestrator } from '@/server/master/orchestrator';

declare global {
  // eslint-disable-next-line no-var
  var __masterRepository: SqliteMasterRepository | undefined;
  // eslint-disable-next-line no-var
  var __masterOrchestrator: MasterOrchestrator | undefined;
}

export function getMasterRepository(): SqliteMasterRepository {
  if (!globalThis.__masterRepository) {
    globalThis.__masterRepository = new SqliteMasterRepository();
  }
  return globalThis.__masterRepository;
}

export function resetMasterRepositoryForTests(): void {
  globalThis.__masterOrchestrator = undefined;
  if (globalThis.__masterRepository) {
    globalThis.__masterRepository.close();
    globalThis.__masterRepository = undefined;
  }
}

export function getMasterOrchestrator(): MasterOrchestrator {
  if (!globalThis.__masterOrchestrator) {
    globalThis.__masterOrchestrator = new MasterOrchestrator(getMasterRepository());
  }
  return globalThis.__masterOrchestrator;
}
