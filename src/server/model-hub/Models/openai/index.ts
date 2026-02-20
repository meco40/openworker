import type { ProviderAdapter } from '../types';
import {
  dispatchOpenAICompatibleChat,
  fetchOpenAICompatibleModels,
  testOpenAICompatibleModelsEndpoint,
} from '../shared/openaiCompatible';

const openAIProviderAdapter: ProviderAdapter = {
  id: 'openai',
  fetchModels: ({ secret }) =>
    fetchOpenAICompatibleModels('https://api.openai.com/v1', secret, 'openai'),
  testConnectivity: ({ secret }) =>
    testOpenAICompatibleModelsEndpoint(
      'https://api.openai.com/v1',
      secret,
      'OpenAI connectivity verified (models list reachable).',
      'OpenAI connectivity failed: ',
    ),
  dispatchGateway: ({ secret }, request, options) =>
    dispatchOpenAICompatibleChat('https://api.openai.com/v1', secret, 'openai', request, {
      signal: options?.signal,
      onStreamDelta: options?.onStreamDelta,
    }),
};

export default openAIProviderAdapter;
