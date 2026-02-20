import type { ProviderAdapter } from '../types';
import {
  dispatchOpenAICompatibleChat,
  fetchOpenAICompatibleModels,
  testOpenAICompatibleModelsEndpoint,
} from '../shared/openaiCompatible';

const xAIProviderAdapter: ProviderAdapter = {
  id: 'xai',
  fetchModels: ({ secret }) => fetchOpenAICompatibleModels('https://api.x.ai/v1', secret, 'xai'),
  testConnectivity: ({ secret }) =>
    testOpenAICompatibleModelsEndpoint(
      'https://api.x.ai/v1',
      secret,
      'xAI connectivity verified (models list reachable).',
      'xAI connectivity failed: ',
    ),
  dispatchGateway: ({ secret }, request, options) =>
    dispatchOpenAICompatibleChat('https://api.x.ai/v1', secret, 'xai', request, {
      signal: options?.signal,
      onStreamDelta: options?.onStreamDelta,
    }),
};

export default xAIProviderAdapter;
