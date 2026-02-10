import type { ProviderAdapter } from '../types';
import {
  dispatchOpenAICompatibleChat,
  fetchOpenAICompatibleModels,
  testOpenAICompatibleModelsEndpoint,
} from '../shared/openaiCompatible';

const kimiProviderAdapter: ProviderAdapter = {
  id: 'kimi',
  fetchModels: ({ secret }) => fetchOpenAICompatibleModels('https://api.moonshot.cn/v1', secret, 'kimi'),
  testConnectivity: ({ secret }) =>
    testOpenAICompatibleModelsEndpoint(
      'https://api.moonshot.cn/v1',
      secret,
      'Kimi connectivity verified (models list reachable).',
      'Kimi connectivity failed: ',
    ),
  dispatchGateway: ({ secret }, request) =>
    dispatchOpenAICompatibleChat('https://api.moonshot.cn/v1', secret, 'kimi', request),
};

export default kimiProviderAdapter;
