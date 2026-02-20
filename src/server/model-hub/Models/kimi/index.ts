import type { FetchedModel, ProviderAdapter } from '@/server/model-hub/Models/types';
import {
  dispatchOpenAICompatibleChat,
  fetchOpenAICompatibleModels,
  testOpenAICompatibleModelsEndpoint,
} from '@/server/model-hub/Models/shared/openaiCompatible';

const KIMI_CODE_BASE_URL = 'https://api.kimi.com/coding/v1';

function mapDefaultModels(defaultModels: string[]): FetchedModel[] {
  return defaultModels.map((id) => ({
    id,
    name: id,
    provider: 'kimi',
  }));
}

function mergeUniqueModels(primary: FetchedModel[], secondary: FetchedModel[]): FetchedModel[] {
  const seen = new Set<string>();
  const merged: FetchedModel[] = [];
  for (const model of [...primary, ...secondary]) {
    if (!model?.id || seen.has(model.id)) continue;
    seen.add(model.id);
    merged.push(model);
  }
  return merged;
}

const kimiProviderAdapter: ProviderAdapter = {
  id: 'kimi',
  fetchModels: async ({ secret, provider }) => {
    const remoteModels = await fetchOpenAICompatibleModels(
      KIMI_CODE_BASE_URL,
      secret,
      'kimi',
    ).catch(() => []);
    const fallbackDefaults =
      provider.defaultModels.length > 0 ? provider.defaultModels : ['kimi-for-coding'];
    const seedModels = mapDefaultModels([...new Set(fallbackDefaults)]);
    return mergeUniqueModels(remoteModels, seedModels);
  },
  testConnectivity: async ({ secret }) => {
    const result = await testOpenAICompatibleModelsEndpoint(
      KIMI_CODE_BASE_URL,
      secret,
      'Kimi connectivity verified (models list reachable).',
      'Kimi connectivity failed: ',
    );

    if (!result.ok && result.message.includes('invalid_authentication_error')) {
      return {
        ok: false,
        message:
          'Kimi connectivity failed: Invalid Authentication (invalid_authentication_error). ' +
          'Use a Kimi Code key (sk-kimi-...) from kimi.com/code/console for endpoint api.kimi.com/coding/v1, without extra quotes/prefix.',
      };
    }

    return result;
  },
  dispatchGateway: ({ secret }, request, options) =>
    dispatchOpenAICompatibleChat(KIMI_CODE_BASE_URL, secret, 'kimi', request, {
      signal: options?.signal,
      onStreamDelta: options?.onStreamDelta,
    }),
};

export default kimiProviderAdapter;
