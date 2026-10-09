import type { ProviderAdapter } from '@/server/model-hub/Models/types';
import {
  dispatchOpenAICompatibleChat,
  fetchOpenAICompatibleModels,
  testOpenAICompatibleModelsEndpoint,
} from '@/server/model-hub/Models/shared/openai-compatible';

function lmStudioBaseUrl(): string {
  return (process.env.LMSTUDIO_BASE_URL || 'http://localhost:1234/v1').replace(/\/$/, '');
}

const lmStudioProviderAdapter: ProviderAdapter = {
  id: 'lmstudio',
  fetchModels: ({ secret }) => fetchOpenAICompatibleModels(lmStudioBaseUrl(), secret, 'lmstudio'),
  testConnectivity: ({ secret }) =>
    testOpenAICompatibleModelsEndpoint(
      lmStudioBaseUrl(),
      secret,
      'LM Studio connectivity verified.',
      'LM Studio connectivity failed: ',
    ),
  dispatchGateway: ({ secret }, request, options) =>
    dispatchOpenAICompatibleChat(lmStudioBaseUrl(), secret, 'lmstudio', request, {
      signal: options?.signal,
      onStreamDelta: options?.onStreamDelta,
    }),
};

export default lmStudioProviderAdapter;
