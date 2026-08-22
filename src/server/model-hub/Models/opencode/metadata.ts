import type { FetchedModel } from '@/server/model-hub/Models/types';
import { fetchWithTimeout } from '@/server/model-hub/Models/shared/http';

const MODELS_DEV_API_URL = 'https://models.dev/api.json';

interface OpenCodeModelMetadata {
  name?: string;
  context_window?: number;
  billing?: 'free' | 'paid';
}

const FALLBACK_METADATA: Record<string, OpenCodeModelMetadata> = {
  'ox-alpha-free': { name: 'Ox Alpha Free', billing: 'free' },
  'x-preview-f-free': { name: 'Ox Alpha Free', billing: 'free' },
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function parseBilling(value: unknown): 'free' | 'paid' | undefined {
  const cost = asRecord(value);
  if (!cost || typeof cost.input !== 'number' || typeof cost.output !== 'number') {
    return undefined;
  }

  const directCosts = Object.values(cost).filter(
    (entry): entry is number => typeof entry === 'number' && Number.isFinite(entry),
  );

  if (directCosts.length === 0) return undefined;
  return directCosts.every((entry) => entry === 0) ? 'free' : 'paid';
}

function normalizeDisplayName(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return value.replace(/\s+\(Unlimited\)$/i, '').trim();
}

function parseMetadata(value: unknown): OpenCodeModelMetadata {
  const model = asRecord(value);
  if (!model) return {};

  const limit = asRecord(model.limit);
  const contextWindow = limit?.context;

  return {
    name: normalizeDisplayName(model.name),
    context_window:
      typeof contextWindow === 'number' && Number.isFinite(contextWindow)
        ? contextWindow
        : undefined,
    billing: parseBilling(model.cost),
  };
}

export async function fetchOpenCodeModelMetadata(): Promise<Map<string, OpenCodeModelMetadata>> {
  try {
    const response = await fetchWithTimeout(MODELS_DEV_API_URL, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) return new Map();

    const payload = asRecord(await response.json());
    const provider = asRecord(payload?.opencode);
    const models = asRecord(provider?.models);
    if (!models) return new Map();

    return new Map(Object.entries(models).map(([id, model]) => [id, parseMetadata(model)]));
  } catch {
    // Model metadata must never prevent the provider's live model list from loading.
    return new Map();
  }
}

export function enrichOpenCodeModels(
  models: FetchedModel[],
  metadata: Map<string, OpenCodeModelMetadata>,
): FetchedModel[] {
  return models.map((model) => {
    const providerMetadata = metadata.get(model.id);
    const fallbackMetadata = FALLBACK_METADATA[model.id];

    return {
      ...model,
      name: providerMetadata?.name ?? fallbackMetadata?.name ?? model.name,
      context_window:
        providerMetadata?.context_window ??
        fallbackMetadata?.context_window ??
        model.context_window,
      billing: providerMetadata?.billing ?? fallbackMetadata?.billing,
    };
  });
}
