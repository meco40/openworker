import type { ProviderAdapter } from '../types';
import {
  dispatchOpenAICompatibleChat,
  fetchOpenAICompatibleModels,
  testOpenAICompatibleModelsEndpoint,
} from '../shared/openaiCompatible';

const mistralProviderAdapter: ProviderAdapter = {
  id: 'mistral',
  fetchModels: ({ secret }) => fetchOpenAICompatibleModels('https://api.mistral.ai/v1', secret, 'mistral'),
  testConnectivity: ({ secret }) =>
    testOpenAICompatibleModelsEndpoint(
      'https://api.mistral.ai/v1',
      secret,
      'Mistral connectivity verified (models list reachable).',
      'Mistral connectivity failed: ',
    ),
  dispatchGateway: ({ secret }, request) =>
    dispatchOpenAICompatibleChat('https://api.mistral.ai/v1', secret, 'mistral', request),
};

export default mistralProviderAdapter;
