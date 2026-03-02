import type { ProviderAdapter } from '@/server/model-hub/Models/types';
import { fetchJsonOk, fetchWithTimeout } from '@/server/model-hub/Models/shared/http';
import { dispatchOpenAICompatibleChat } from '@/server/model-hub/Models/shared/openai-compatible';

const openRouterProviderAdapter: ProviderAdapter = {
  id: 'openrouter',

  async fetchModels({ secret }) {
    const response = await fetchWithTimeout('https://openrouter.ai/api/v1/models', {
      method: 'GET',
      headers: { Authorization: `Bearer ${secret}` },
    });
    if (!response.ok) return [];

    const json = (await response.json()) as {
      data?: Array<{ id: string; name?: string; context_length?: number }>;
    };

    return (json.data ?? []).map((model) => ({
      id: model.id,
      name: model.name || model.id,
      provider: 'openrouter',
      context_window: model.context_length,
    }));
  },

  async testConnectivity({ secret }) {
    const result = await fetchJsonOk('https://openrouter.ai/api/v1/key', {
      method: 'GET',
      headers: { Authorization: `Bearer ${secret}` },
    });

    return result.ok
      ? { ok: true, message: 'OpenRouter connectivity verified (key endpoint reachable).' }
      : { ok: false, message: `OpenRouter connectivity failed: ${result.message}` };
  },

  dispatchGateway: ({ secret }, request, options) =>
    dispatchOpenAICompatibleChat('https://openrouter.ai/api/v1', secret, 'openrouter', request, {
      extraHeaders: {
        'HTTP-Referer': 'https://openclaw.app',
        'X-Title': 'OpenClaw',
      },
      signal: options?.signal,
      onStreamDelta: options?.onStreamDelta,
    }),
};

export default openRouterProviderAdapter;
