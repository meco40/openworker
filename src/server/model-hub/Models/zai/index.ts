import type { ProviderAdapter } from '../types';
import { fetchJsonOk } from '../shared/http';
import {
  dispatchOpenAICompatibleChat,
  fetchOpenAICompatibleModels,
} from '../shared/openaiCompatible';

const zaiProviderAdapter: ProviderAdapter = {
  id: 'zai',
  fetchModels: ({ secret }) =>
    fetchOpenAICompatibleModels('https://api.z.ai/api/paas/v4', secret, 'zai'),

  async testConnectivity({ provider, secret }, options = {}) {
    const model = options.model || provider.defaultModels[0];
    if (!model) {
      return { ok: false, message: 'Z.AI test requires a model id.' };
    }

    const result = await fetchJsonOk('https://api.z.ai/api/paas/v4/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secret}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 4,
      }),
    });

    return result.ok
      ? { ok: true, message: 'Z.AI connectivity verified.' }
      : { ok: false, message: `Z.AI connectivity failed: ${result.message}` };
  },

  dispatchGateway: ({ secret }, request) =>
    dispatchOpenAICompatibleChat('https://api.z.ai/api/paas/v4', secret, 'zai', request),
};

export default zaiProviderAdapter;
