import type { FetchedModel, ProviderAdapter } from '@/server/model-hub/Models/types';
import { dispatchOpenAICompatibleChat } from '@/server/model-hub/Models/shared/openai-compatible';
import { fetchWithTimeout } from '@/server/model-hub/Models/shared/http';

const OLLAMA_OPENAI_BASE_URL = 'http://localhost:11434/v1';
const OLLAMA_TAGS_URL = 'http://localhost:11434/api/tags';

function mapDefaultModels(defaultModels: string[]): FetchedModel[] {
  return defaultModels.map((id) => ({
    id,
    name: id,
    provider: 'ollama',
  }));
}

function mergeUniqueModels(primary: FetchedModel[], secondary: FetchedModel[]): FetchedModel[] {
  const seen = new Set<string>();
  const merged: FetchedModel[] = [];
  for (const model of [...primary, ...secondary]) {
    if (!model?.id || seen.has(model.id)) continue;
    seen.add(model.id);
    merged.push(model);
  }
  return merged;
}

async function fetchOllamaTags(secret: string): Promise<FetchedModel[]> {
  const headers: Record<string, string> = {};
  if (secret.trim()) {
    headers.Authorization = `Bearer ${secret.trim()}`;
  }

  const response = await fetchWithTimeout(
    OLLAMA_TAGS_URL,
    {
      method: 'GET',
      headers,
    },
    20_000,
  );
  if (!response.ok) return [];

  const payload = (await response.json()) as {
    models?: Array<{ name?: string; model?: string }>;
  };
  return (payload.models || [])
    .map((model) => String(model.model || model.name || '').trim())
    .filter(Boolean)
    .map((id) => ({
      id,
      name: id,
      provider: 'ollama',
    }));
}

const ollamaProviderAdapter: ProviderAdapter = {
  id: 'ollama',
  fetchModels: async ({ secret, provider }) => {
    const remote = await fetchOllamaTags(secret).catch(() => []);
    const fallback = mapDefaultModels(provider.defaultModels);
    return mergeUniqueModels(remote, fallback);
  },
  testConnectivity: ({ secret }) =>
    fetchOllamaTags(secret)
      .then((models) => ({
        ok: models.length > 0,
        message:
          models.length > 0
            ? 'Ollama connectivity verified.'
            : 'Ollama connectivity failed: no local models returned by /api/tags.',
      }))
      .catch((error: unknown) => ({
        ok: false,
        message: `Ollama connectivity failed: ${
          error instanceof Error ? error.message : 'request failed'
        }`,
      })),
  dispatchGateway: ({ secret }, request, options) =>
    dispatchOpenAICompatibleChat(OLLAMA_OPENAI_BASE_URL, secret, 'ollama', request, {
      signal: options?.signal,
      onStreamDelta: options?.onStreamDelta,
    }),
};

export default ollamaProviderAdapter;
