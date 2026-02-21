import type { ProviderAdapter } from '@/server/model-hub/Models/types';
import { buildCodexSeedModels, mergeUniqueModels } from './utils/models';
import { dispatchCodexResponses } from './client/dispatch';
import { testOpenAICodexConnectivity } from './connectivity/testConnectivity';

const openAICodexProviderAdapter: ProviderAdapter = {
  id: 'openai-codex',
  fetchModels: async ({ provider }) => {
    const seedModels = buildCodexSeedModels(provider.defaultModels);
    return mergeUniqueModels(seedModels, []);
  },
  testConnectivity: ({ secret, provider }, options) =>
    testOpenAICodexConnectivity({
      secret,
      defaultModels: provider.defaultModels,
      model: options?.model,
    }),
  dispatchGateway: ({ secret }, request, options) =>
    dispatchCodexResponses(secret, request, {
      signal: options?.signal,
      onStreamDelta: options?.onStreamDelta,
    }),
};

export default openAICodexProviderAdapter;
