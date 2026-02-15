import { getProviderAdapter, type FetchedModel } from './Models';
import { fetchOpenAICompatibleModels } from './Models/shared/openaiCompatible';
import { decryptSecret } from './crypto';
import { PROVIDER_CATALOG } from './providerCatalog';
import type { ProviderAccountRecord } from './repository';

function findProvider(providerId: string) {
  return PROVIDER_CATALOG.find((provider) => provider.id === providerId) ?? null;
}

function mapDefaultModels(providerId: string, defaultModels: string[]): FetchedModel[] {
  return defaultModels.map((id) => ({
    id,
    name: id,
    provider: providerId,
  }));
}

/**
 * Fetches the list of available models for a provider account.
 * Uses provider-specific adapters where available, falls back to static defaults.
 */
export async function fetchModelsForAccount(
  account: ProviderAccountRecord,
  encryptionKey: string,
): Promise<FetchedModel[]> {
  const provider = findProvider(account.providerId);
  if (!provider) return [];

  const secret = decryptSecret(account.encryptedSecret, encryptionKey);
  if (account.authMethod !== 'none' && !secret?.trim()) return [];

  const adapter = getProviderAdapter(provider.id);
  const context = { provider, account, secret };

  try {
    if (adapter?.fetchModels) {
      return await adapter.fetchModels(context);
    }

    if (provider.apiBaseUrl) {
      return await fetchOpenAICompatibleModels(provider.apiBaseUrl, secret, provider.id);
    }

    return mapDefaultModels(provider.id, provider.defaultModels);
  } catch {
    return mapDefaultModels(provider.id, provider.defaultModels);
  }
}

export type { FetchedModel };
