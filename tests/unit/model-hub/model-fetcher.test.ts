import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ProviderAccountRecord } from '@/server/model-hub/repository';
import type { ProviderCatalogEntry } from '@/server/model-hub/types';

function buildAccount(
  providerId: string,
  authMethod: 'none' | 'api_key' = 'api_key',
): ProviderAccountRecord {
  const now = new Date().toISOString();
  return {
    id: `acc-${providerId}`,
    providerId,
    label: providerId,
    authMethod,
    secretMasked: '****',
    hasRefreshToken: false,
    createdAt: now,
    updatedAt: now,
    lastCheckAt: null,
    lastCheckOk: null,
    encryptedSecret: {
      alg: 'aes-256-gcm',
      keyId: 'default',
      iv: 'iv',
      ciphertext: 'ciphertext',
      tag: 'tag',
    },
    encryptedRefreshToken: null,
  };
}

async function setupFetcher(options: {
  catalog: ProviderCatalogEntry[];
  adapter?: { fetchModels?: ReturnType<typeof vi.fn> } | null;
  decryptSecretReturn?: string;
  openAICompatibleResult?: Array<{ id: string; name: string; provider: string }>;
  openAICompatibleThrows?: boolean;
  openRouterEmbeddingResult?: Array<{ id: string; name?: string; context_length?: number }>;
  openRouterEmbeddingThrows?: boolean;
}) {
  vi.resetModules();

  const getProviderAdapter = vi.fn(() => options.adapter ?? null);
  const decryptSecret = vi.fn(() => options.decryptSecretReturn ?? 'provider-secret');
  const fetchOpenAICompatibleModels = options.openAICompatibleThrows
    ? vi.fn(async () => {
        throw new Error('openai-compatible failed');
      })
    : vi.fn(async () => options.openAICompatibleResult ?? []);
  const fetchWithTimeout = options.openRouterEmbeddingThrows
    ? vi.fn(async () => {
        throw new Error('openrouter embeddings failed');
      })
    : vi.fn(async () => ({
        ok: true,
        json: async () => ({ data: options.openRouterEmbeddingResult ?? [] }),
      }));

  vi.doMock('../../../src/server/model-hub/providerCatalog', () => ({
    PROVIDER_CATALOG: options.catalog,
  }));
  vi.doMock('../../../src/server/model-hub/Models', () => ({
    getProviderAdapter,
  }));
  vi.doMock('../../../src/server/model-hub/Models/shared/openaiCompatible', () => ({
    fetchOpenAICompatibleModels,
  }));
  vi.doMock('../../../src/server/model-hub/Models/shared/http', () => ({
    fetchWithTimeout,
  }));
  vi.doMock('../../../src/server/model-hub/crypto', () => ({
    decryptSecret,
  }));

  const mod = await import('@/server/model-hub/modelFetcher');
  return {
    fetchModelsForAccount: mod.fetchModelsForAccount,
    getProviderAdapter,
    fetchOpenAICompatibleModels,
    fetchWithTimeout,
    decryptSecret,
  };
}

describe('fetchModelsForAccount', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('returns empty list when provider is unknown', async () => {
    const { fetchModelsForAccount } = await setupFetcher({
      catalog: [],
    });

    const result = await fetchModelsForAccount(buildAccount('unknown'), 'key');
    expect(result).toEqual([]);
  });

  it('returns empty list when secret is missing for authenticated providers', async () => {
    const { fetchModelsForAccount, decryptSecret } = await setupFetcher({
      catalog: [
        {
          id: 'openai',
          name: 'OpenAI',
          icon: 'O',
          authMethods: ['api_key'],
          endpointType: 'openai-native',
          capabilities: ['chat'],
          defaultModels: ['gpt-4.1'],
          apiBaseUrl: 'https://api.openai.com/v1',
        },
      ],
      decryptSecretReturn: '   ',
    });

    const result = await fetchModelsForAccount(buildAccount('openai', 'api_key'), 'key');
    expect(result).toEqual([]);
    expect(decryptSecret).toHaveBeenCalled();
  });

  it('uses adapter fetchModels when available', async () => {
    const adapterFetch = vi.fn(async () => [{ id: 'a', name: 'a', provider: 'openai' }]);
    const { fetchModelsForAccount, getProviderAdapter } = await setupFetcher({
      catalog: [
        {
          id: 'openai',
          name: 'OpenAI',
          icon: 'O',
          authMethods: ['api_key'],
          endpointType: 'openai-native',
          capabilities: ['chat'],
          defaultModels: ['gpt-4.1'],
          apiBaseUrl: 'https://api.openai.com/v1',
        },
      ],
      adapter: { fetchModels: adapterFetch },
    });

    const result = await fetchModelsForAccount(buildAccount('openai'), 'key');

    expect(getProviderAdapter).toHaveBeenCalledWith('openai');
    expect(adapterFetch).toHaveBeenCalledTimes(1);
    expect(result).toEqual([{ id: 'a', name: 'a', provider: 'openai' }]);
  });

  it('falls back to OpenAI-compatible model listing when no adapter exists', async () => {
    const { fetchModelsForAccount, fetchOpenAICompatibleModels } = await setupFetcher({
      catalog: [
        {
          id: 'openrouter',
          name: 'OpenRouter',
          icon: 'R',
          authMethods: ['api_key'],
          endpointType: 'openai-compatible',
          capabilities: ['chat'],
          defaultModels: ['openai/gpt-4.1-mini'],
          apiBaseUrl: 'https://openrouter.ai/api/v1',
        },
      ],
      adapter: null,
      openAICompatibleResult: [{ id: 'm1', name: 'm1', provider: 'openrouter' }],
    });

    const result = await fetchModelsForAccount(buildAccount('openrouter'), 'key');

    expect(fetchOpenAICompatibleModels).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1',
      'provider-secret',
      'openrouter',
    );
    expect(result).toEqual([{ id: 'm1', name: 'm1', provider: 'openrouter' }]);
  });

  it('uses OpenRouter embeddings endpoint when purpose is embedding', async () => {
    const { fetchModelsForAccount, fetchWithTimeout } = await setupFetcher({
      catalog: [
        {
          id: 'openrouter',
          name: 'OpenRouter',
          icon: 'R',
          authMethods: ['api_key'],
          endpointType: 'openai-compatible',
          capabilities: ['chat', 'embeddings'],
          defaultModels: ['openai/gpt-4.1-mini'],
          apiBaseUrl: 'https://openrouter.ai/api/v1',
        },
      ],
      adapter: null,
      openRouterEmbeddingResult: [
        { id: 'qwen/qwen3-embedding-8b', name: 'Qwen3 Embedding 8B', context_length: 32768 },
      ],
    });

    const result = await fetchModelsForAccount(buildAccount('openrouter'), 'key', {
      purpose: 'embedding',
    });

    expect(fetchWithTimeout).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/embeddings/models',
      {
        method: 'GET',
        headers: { Authorization: 'Bearer provider-secret' },
      },
    );
    expect(result).toEqual([
      {
        id: 'qwen/qwen3-embedding-8b',
        name: 'Qwen3 Embedding 8B',
        provider: 'openrouter',
        context_window: 32768,
      },
    ]);
  });

  it('returns default models when provider has no apiBase and no adapter', async () => {
    const { fetchModelsForAccount } = await setupFetcher({
      catalog: [
        {
          id: 'custom',
          name: 'Custom',
          icon: 'C',
          authMethods: ['none'],
          endpointType: 'openai-compatible',
          capabilities: ['chat'],
          defaultModels: ['model-a', 'model-b'],
        },
      ],
      adapter: null,
    });

    const result = await fetchModelsForAccount(buildAccount('custom', 'none'), 'key');

    expect(result).toEqual([
      { id: 'model-a', name: 'model-a', provider: 'custom' },
      { id: 'model-b', name: 'model-b', provider: 'custom' },
    ]);
  });

  it('falls back to default models when adapter/openai-compatible lookup throws', async () => {
    const { fetchModelsForAccount } = await setupFetcher({
      catalog: [
        {
          id: 'openrouter',
          name: 'OpenRouter',
          icon: 'R',
          authMethods: ['api_key'],
          endpointType: 'openai-compatible',
          capabilities: ['chat'],
          defaultModels: ['openai/gpt-4.1-mini'],
          apiBaseUrl: 'https://openrouter.ai/api/v1',
        },
      ],
      adapter: null,
      openAICompatibleThrows: true,
    });

    const result = await fetchModelsForAccount(buildAccount('openrouter'), 'key');
    expect(result).toEqual([
      {
        id: 'openai/gpt-4.1-mini',
        name: 'openai/gpt-4.1-mini',
        provider: 'openrouter',
      },
    ]);
  });
});
