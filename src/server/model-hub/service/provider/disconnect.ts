import type { ModelHubRepository } from '@/server/model-hub/repository';

export function disconnectProviderAccount(
  repository: ModelHubRepository,
  accountId: string,
): boolean {
  return repository.deleteAccount(accountId);
}
