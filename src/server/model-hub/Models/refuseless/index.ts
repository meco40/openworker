import type { ProviderAdapter, FetchedModel } from '@/server/model-hub/Models/types';
import {
  dispatchOpenAICompatibleChat,
  fetchOpenAICompatibleModels,
  testOpenAICompatibleModelsEndpoint,
} from '@/server/model-hub/Models/shared/openai-compatible';

const BASE_URL = 'https://api.refuseless.com/v1';
export const DEEPSEEK_MODEL = {
  id: 'deepseek-v4.1-flash-abliterated',
  name: 'DeepSeek V4.1 Flash 1017 Abliterated',
  tools: true,
  reasoning: true,
  limit: { context: 1048576, output: 131072 },
} as const;

const refuselessProviderAdapter: ProviderAdapter = {
  id: 'refuseless',
  fetchModels: async ({ secret }) => {
    const models = await fetchOpenAICompatibleModels(BASE_URL, secret, 'refuseless').catch(
      (): FetchedModel[] => [],
    );
    if (!models.some((model) => model.id === DEEPSEEK_MODEL.id)) {
      models.push({ id: DEEPSEEK_MODEL.id, name: DEEPSEEK_MODEL.name, provider: 'refuseless' });
    }
    return models.map((model): FetchedModel =>
      model.id === DEEPSEEK_MODEL.id
        ? { ...model, name: DEEPSEEK_MODEL.name, context_window: DEEPSEEK_MODEL.limit.context }
        : model,
    );
  },
  testConnectivity: ({ secret }) =>
    testOpenAICompatibleModelsEndpoint(
      BASE_URL,
      secret,
      'Refuseless connectivity verified.',
      'Refuseless connectivity failed: ',
    ),
  dispatchGateway: ({ secret }, request, options) =>
    dispatchOpenAICompatibleChat(
      BASE_URL,
      secret,
      'refuseless',
      {
        ...request,
        max_tokens:
          request.model === DEEPSEEK_MODEL.id && request.max_tokens !== undefined
            ? Math.min(request.max_tokens, DEEPSEEK_MODEL.limit.output)
            : request.max_tokens,
        // Refuseless supports off/none, low, high and max, but no medium level.
        reasoning_effort: request.reasoning_effort === 'medium' ? 'low' : request.reasoning_effort,
      },
      options,
    ),
};

export default refuselessProviderAdapter;
