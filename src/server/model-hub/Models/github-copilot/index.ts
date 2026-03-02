import type { ProviderAdapter } from '@/server/model-hub/Models/types';
import { fetchJsonOk, fetchWithTimeout } from '@/server/model-hub/Models/shared/http';
import { dispatchOpenAICompatibleChat } from '@/server/model-hub/Models/shared/openai-compatible';

const githubProviderAdapter: ProviderAdapter = {
  id: 'github-copilot',

  async fetchModels({ secret }) {
    const response = await fetchWithTimeout('https://api.github.com/marketplace_listing/models', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${secret}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });

    if (!response.ok) {
      const fallback = await fetchWithTimeout('https://models.inference.ai.azure.com/info', {
        method: 'GET',
        headers: { Authorization: `Bearer ${secret}` },
      }).catch(() => null);

      if (fallback?.ok) {
        const info = (await fallback.json().catch(() => null)) as unknown;
        if (Array.isArray(info)) {
          return info.map((entry) => {
            const record = entry as { id?: string; model_name?: string };
            return {
              id: String(record.id || record.model_name || ''),
              name: String(record.model_name || record.id || ''),
              provider: 'github-copilot',
            };
          });
        }
      }

      return [
        { id: 'gpt-4o', name: 'GPT-4o (GitHub)', provider: 'github-copilot' },
        { id: 'gpt-4o-mini', name: 'GPT-4o Mini (GitHub)', provider: 'github-copilot' },
        { id: 'o1-preview', name: 'o1-preview (GitHub)', provider: 'github-copilot' },
        { id: 'o1-mini', name: 'o1-mini (GitHub)', provider: 'github-copilot' },
      ];
    }

    const json = (await response.json()) as Array<{
      id?: string;
      name?: string;
      friendly_name?: string;
    }>;

    return (Array.isArray(json) ? json : []).map((model) => ({
      id: String(model.id || model.name || ''),
      name: String(model.friendly_name || model.name || model.id || ''),
      provider: 'github-copilot',
    }));
  },

  async testConnectivity({ secret }) {
    const result = await fetchJsonOk('https://models.inference.ai.azure.com/info', {
      method: 'GET',
      headers: { Authorization: `Bearer ${secret}` },
    });

    if (result.ok) {
      return {
        ok: true,
        message: 'GitHub Models connectivity verified (inference endpoint reachable).',
      };
    }

    const userResult = await fetchJsonOk('https://api.github.com/user', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${secret}`,
        Accept: 'application/vnd.github+json',
      },
    });

    return userResult.ok
      ? { ok: true, message: 'GitHub connectivity verified (user endpoint reachable).' }
      : { ok: false, message: `GitHub connectivity failed: ${result.message}` };
  },

  dispatchGateway: ({ secret }, request, options) =>
    dispatchOpenAICompatibleChat(
      'https://models.inference.ai.azure.com',
      secret,
      'github-copilot',
      request,
      {
        signal: options?.signal,
        onStreamDelta: options?.onStreamDelta,
      },
    ),
};

export default githubProviderAdapter;
