import { ModelHubService } from './service';
import { SqliteModelHubRepository } from './repositories/sqliteModelHubRepository';

const DEV_FALLBACK_KEY = '0123456789abcdef0123456789abcdef';

declare global {
  var __modelHubRepository: SqliteModelHubRepository | undefined;
  var __modelHubService: ModelHubService | undefined;
}

export function getModelHubEncryptionKey(): string {
  const key = process.env.MODEL_HUB_ENCRYPTION_KEY?.trim();
  if (key && key.length > 0) return key;

  if (process.env.NODE_ENV !== 'production') {
    return DEV_FALLBACK_KEY;
  }

  throw new Error('Missing MODEL_HUB_ENCRYPTION_KEY');
}

export function getModelHubRepository(): SqliteModelHubRepository {
  if (!globalThis.__modelHubRepository) {
    globalThis.__modelHubRepository = new SqliteModelHubRepository();
  }
  return globalThis.__modelHubRepository;
}

export function getModelHubService(): ModelHubService {
  if (!globalThis.__modelHubService) {
    globalThis.__modelHubService = new ModelHubService(getModelHubRepository());
  }
  return globalThis.__modelHubService;
}
