import type { ProviderAdapter } from '../types';
import { fetchJsonOk } from '../shared/http';
import { dispatchOpenAICompatibleChat } from '../shared/openaiCompatible';

const bytedanceProviderAdapter: ProviderAdapter = {
  id: 'bytedance',

  async fetchModels() {
    return [
      { id: 'doubao-1-5-lite-32k-250115', name: 'Doubao 1.5 Lite 32K', provider: 'bytedance' },
      { id: 'doubao-1-5-pro-32k-250115', name: 'Doubao 1.5 Pro 32K', provider: 'bytedance' },
      { id: 'doubao-1-5-pro-256k-250115', name: 'Doubao 1.5 Pro 256K', provider: 'bytedance' },
    ];
  },

  async testConnectivity({ provider, secret }, options = {}) {
    const model = options.model || provider.defaultModels[0];
    if (!model) {
      return { ok: false, message: 'ByteDance test requires a model/endpoint id.' };
    }

    const result = await fetchJsonOk('https://ark.cn-beijing.volces.com/api/v3/chat/completions', {
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
      ? { ok: true, message: 'ByteDance ModelArk connectivity verified.' }
      : { ok: false, message: `ByteDance connectivity failed: ${result.message}` };
  },

  dispatchGateway: ({ secret }, request) =>
    dispatchOpenAICompatibleChat(
      'https://ark.cn-beijing.volces.com/api/v3',
      secret,
      'bytedance',
      request,
    ),
};

export default bytedanceProviderAdapter;
