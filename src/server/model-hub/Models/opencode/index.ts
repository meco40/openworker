import type { ProviderAdapter } from '@/server/model-hub/Models/types';
import {
  dispatchOpenAICompatibleChat,
  fetchOpenAICompatibleModels,
  testOpenAICompatibleModelsEndpoint,
} from '@/server/model-hub/Models/shared/openai-compatible';
import { enrichOpenCodeModels, fetchOpenCodeModelMetadata } from './metadata';

const openCodeProviderAdapter: ProviderAdapter = {
  id: 'opencode',

  fetchModels: async ({ provider, secret }) => {
    if (!provider.apiBaseUrl) return Promise.resolve([]);

    const models = await fetchOpenAICompatibleModels(provider.apiBaseUrl, secret, 'opencode');
    if (models.length === 0) return models;

    const metadata = await fetchOpenCodeModelMetadata();
    return enrichOpenCodeModels(models, metadata);
  },

  testConnectivity: ({ provider, secret }) => {
    if (!provider.apiBaseUrl) {
      return Promise.resolve({ ok: false, message: 'OpenCode has no configured API base URL.' });
    }

    return testOpenAICompatibleModelsEndpoint(
      provider.apiBaseUrl,
      secret,
      'OpenCode connectivity verified (models list reachable).',
      'OpenCode connectivity failed: ',
    );
  },

  dispatchGateway: ({ provider, secret }, request, options) => {
    if (!provider.apiBaseUrl) {
      return Promise.resolve({
        ok: false,
        text: '',
        model: request.model,
        provider: 'opencode',
        error: 'OpenCode has no configured API base URL.',
      });
    }

    return dispatchOpenAICompatibleChat(provider.apiBaseUrl, secret, 'opencode', request, {
      signal: options?.signal,
      onStreamDelta: options?.onStreamDelta,
    });
  },
};

export default openCodeProviderAdapter;
