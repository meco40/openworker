import { getProviderAdapter, type FetchedModel } from '@/server/model-hub/Models';
import { fetchOpenAICompatibleModels } from '@/server/model-hub/Models/shared/openaiCompatible';
import { fetchWithTimeout } from '@/server/model-hub/Models/shared/http';
import { decryptSecret } from '@/server/model-hub/crypto';
import { PROVIDER_CATALOG } from '@/server/model-hub/providerCatalog';
import type { ProviderAccountRecord } from '@/server/model-hub/repository';

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

async function fetchOpenRouterEmbeddingModels(secret: string): Promise<FetchedModel[]> {
  const response = await fetchWithTimeout('https://openrouter.ai/api/v1/embeddings/models', {
    method: 'GET',
    headers: { Authorization: `Bearer ${secret}` },
  });
  if (!response.ok) return [];

  const json = (await response.json()) as {
    data?: Array<{ id: string; name?: string; context_length?: number }>;
  };

  return (json.data ?? []).map((model) => ({
    id: model.id,
    name: model.name || model.id,
    provider: 'openrouter',
    context_window: model.context_length,
  }));
}

/**
 * Fetches the list of available models for a provider account.
 * Uses provider-specific adapters where available, falls back to static defaults.
 */
export async function fetchModelsForAccount(
  account: ProviderAccountRecord,
  encryptionKey: string,
  options?: { purpose?: 'general' | 'embedding' },
): Promise<FetchedModel[]> {
  const provider = findProvider(account.providerId);
  if (!provider) return [];

  const secret = decryptSecret(account.encryptedSecret, encryptionKey);
  if (account.authMethod !== 'none' && !secret?.trim()) return [];

  const adapter = getProviderAdapter(provider.id);
  const context = { provider, account, secret };

  try {
    if (options?.purpose === 'embedding' && provider.id === 'openrouter') {
      const embeddingModels = await fetchOpenRouterEmbeddingModels(secret);
      if (embeddingModels.length > 0) {
        return embeddingModels;
      }
    }

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
