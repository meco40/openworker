import type { ProviderAdapter } from '../types';
import {
  dispatchOpenAICompatibleChat,
  fetchOpenAICompatibleModels,
  testOpenAICompatibleModelsEndpoint,
} from '../shared/openaiCompatible';

const LMSTUDIO_BASE_URL = 'http://localhost:1234/v1';

const lmStudioProviderAdapter: ProviderAdapter = {
  id: 'lmstudio',
  fetchModels: ({ secret }) => fetchOpenAICompatibleModels(LMSTUDIO_BASE_URL, secret, 'lmstudio'),
  testConnectivity: ({ secret }) =>
    testOpenAICompatibleModelsEndpoint(
      LMSTUDIO_BASE_URL,
      secret,
      'LM Studio connectivity verified.',
      'LM Studio connectivity failed: ',
    ),
  dispatchGateway: ({ secret }, request, options) =>
    dispatchOpenAICompatibleChat(LMSTUDIO_BASE_URL, secret, 'lmstudio', request, {
      signal: options?.signal,
    }),
};

export default lmStudioProviderAdapter;
