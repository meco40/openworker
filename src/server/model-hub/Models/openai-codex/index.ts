import type { ConnectivityResult, GatewayRequest, ProviderAdapter } from '../types';
import {
  dispatchOpenAICompatibleChat,
  fetchOpenAICompatibleModels,
  testOpenAICompatibleModelsEndpoint,
} from '../shared/openaiCompatible';
import type { FetchedModel } from '../types';

const CODEX_MODEL_SEED = [
  'gpt-5.3-codex',
  'gpt-5.2-codex',
  'gpt-5.1-codex',
  'gpt-5.1-codex-mini',
  'gpt-5.1-codex-max',
  'gpt-5.2',
] as const;

function mapDefaultModels(defaultModels: string[]) {
  return defaultModels.map((id) => ({
    id,
    name: id,
    provider: 'openai-codex',
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

function buildCodexSeedModels(defaultModels: string[]): FetchedModel[] {
  const mergedDefaults = [...new Set<string>([...defaultModels, ...CODEX_MODEL_SEED])];
  return mapDefaultModels(mergedDefaults);
}

function shouldFallbackFromModelScopeError(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes('missing scopes: api.model.read') || normalized.includes('api.model.read');
}

function resolveCodexProbeModel(preferredModel: string | undefined, defaultModels: string[]): string {
  const normalizedPreferred = preferredModel?.trim();
  if (normalizedPreferred) return normalizedPreferred;
  const normalizedDefault = defaultModels.find((model) => model.trim().length > 0)?.trim();
  if (normalizedDefault) return normalizedDefault;
  return CODEX_MODEL_SEED[0];
}

async function testOpenAICodexConnectivityWithFallback(params: {
  secret: string;
  defaultModels: string[];
  model?: string;
}): Promise<ConnectivityResult> {
  const modelsProbe = await testOpenAICompatibleModelsEndpoint(
    'https://api.openai.com/v1',
    params.secret,
    'OpenAI Codex connectivity verified (models list reachable).',
    'OpenAI Codex connectivity failed: ',
  );
  if (modelsProbe.ok) return modelsProbe;
  if (!shouldFallbackFromModelScopeError(modelsProbe.message)) {
    return modelsProbe;
  }

  const probeModel = resolveCodexProbeModel(params.model, params.defaultModels);
  const probeRequest: GatewayRequest = {
    model: probeModel,
    messages: [{ role: 'user', content: 'ping' }],
    max_tokens: 8,
    temperature: 0,
  };
  const chatProbe = await dispatchOpenAICompatibleChat(
    'https://api.openai.com/v1',
    params.secret,
    'openai-codex',
    probeRequest,
  );
  if (chatProbe.ok) {
    return {
      ok: true,
      message: `OpenAI Codex connectivity verified (chat endpoint reachable with model ${probeModel}).`,
    };
  }
  return {
    ok: false,
    message: `OpenAI Codex connectivity failed: ${chatProbe.error || 'Chat endpoint probe failed.'}`,
  };
}

const openAICodexProviderAdapter: ProviderAdapter = {
  id: 'openai-codex',
  fetchModels: async ({ secret, provider }) => {
    const seedModels = buildCodexSeedModels(provider.defaultModels);
    try {
      const models = await fetchOpenAICompatibleModels(
        'https://api.openai.com/v1',
        secret,
        'openai-codex',
      );
      if (models.length > 0) {
        return mergeUniqueModels(models, seedModels);
      }
    } catch {
      // fall through to default model list
    }

    return seedModels;
  },
  testConnectivity: ({ secret, provider }, options) =>
    testOpenAICodexConnectivityWithFallback({
      secret,
      defaultModels: provider.defaultModels,
      model: options?.model,
    }),
  dispatchGateway: ({ secret }, request, options) =>
    dispatchOpenAICompatibleChat('https://api.openai.com/v1', secret, 'openai-codex', request, {
      signal: options?.signal,
    }),
};

export default openAICodexProviderAdapter;
