import type { ProviderAdapter } from '@/server/model-hub/Models/types';
import {
  dispatchOpenAICompatibleChat,
  fetchOpenAICompatibleModels,
  testOpenAICompatibleModelsEndpoint,
} from '@/server/model-hub/Models/shared/openaiCompatible';

const mistralProviderAdapter: ProviderAdapter = {
  id: 'mistral',
  fetchModels: ({ secret }) =>
    fetchOpenAICompatibleModels('https://api.mistral.ai/v1', secret, 'mistral'),
  testConnectivity: ({ secret }) =>
    testOpenAICompatibleModelsEndpoint(
      'https://api.mistral.ai/v1',
      secret,
      'Mistral connectivity verified (models list reachable).',
      'Mistral connectivity failed: ',
    ),
  dispatchGateway: ({ secret }, request, options) =>
    dispatchOpenAICompatibleChat('https://api.mistral.ai/v1', secret, 'mistral', request, {
      signal: options?.signal,
      onStreamDelta: options?.onStreamDelta,
    }),
};

export default mistralProviderAdapter;
