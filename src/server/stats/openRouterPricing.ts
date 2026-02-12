interface OpenRouterPricingTier {
  minContextTokens: number;
  promptPricePerTokenUsd: number;
  completionPricePerTokenUsd: number;
  requestPriceUsd: number;
}

export interface OpenRouterModelPricing {
  promptPricePerTokenUsd: number;
  completionPricePerTokenUsd: number;
  requestPriceUsd: number;
}

interface OpenRouterPricingCache {
  fetchedAt: number;
  models: Map<string, OpenRouterPricingTier[]>;
  inflight: Promise<void> | null;
}

interface OpenRouterModelsResponse {
  data?: Array<{
    id?: string;
    canonical_slug?: string;
    pricing?: unknown;
  }>;
}

declare global {
  var __openRouterPricingCache: OpenRouterPricingCache | undefined;
}

function getCache(): OpenRouterPricingCache {
  if (!globalThis.__openRouterPricingCache) {
    globalThis.__openRouterPricingCache = {
      fetchedAt: 0,
      models: new Map<string, OpenRouterPricingTier[]>(),
      inflight: null,
    };
  }
  return globalThis.__openRouterPricingCache;
}

function toNumber(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function parseTier(raw: unknown): OpenRouterPricingTier | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  return {
    minContextTokens: Math.max(0, Math.floor(toNumber(row.min_context ?? row.minContext))),
    promptPricePerTokenUsd: Math.max(0, toNumber(row.prompt)),
    completionPricePerTokenUsd: Math.max(0, toNumber(row.completion)),
    requestPriceUsd: Math.max(0, toNumber(row.request)),
  };
}

function parsePricing(raw: unknown): OpenRouterPricingTier[] {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw
      .map(parseTier)
      .filter((row): row is OpenRouterPricingTier => Boolean(row))
      .sort((a, b) => a.minContextTokens - b.minContextTokens);
  }
  const tier = parseTier(raw);
  return tier ? [tier] : [];
}

function selectTier(tiers: OpenRouterPricingTier[], promptTokens: number): OpenRouterPricingTier | null {
  if (tiers.length === 0) return null;
  const normalizedPromptTokens = Math.max(0, Math.floor(promptTokens));
  let selected = tiers[0];
  for (const tier of tiers) {
    if (normalizedPromptTokens >= tier.minContextTokens) {
      selected = tier;
    } else {
      break;
    }
  }
  return selected;
}

function getTtlMs(): number {
  const parsed = Number.parseInt(process.env.OPENROUTER_PRICING_CACHE_TTL_MS || '', 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return 10 * 60 * 1000;
}

function getTimeoutMs(): number {
  const parsed = Number.parseInt(process.env.OPENROUTER_PRICING_FETCH_TIMEOUT_MS || '', 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return 2500;
}

async function refreshCache(apiKey?: string): Promise<void> {
  const cache = getCache();
  if (cache.inflight) {
    await cache.inflight;
    return;
  }

  cache.inflight = (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), getTimeoutMs());
    try {
      const headers: Record<string, string> = {};
      if (apiKey?.trim()) headers.Authorization = `Bearer ${apiKey}`;
      const response = await fetch('https://openrouter.ai/api/v1/models', {
        method: 'GET',
        headers,
        signal: controller.signal,
      });
      if (!response.ok) return;

      const json = (await response.json()) as OpenRouterModelsResponse;
      const nextModels = new Map<string, OpenRouterPricingTier[]>();
      for (const model of json.data ?? []) {
        const tiers = parsePricing(model.pricing);
        if (tiers.length === 0) continue;
        if (model.id) nextModels.set(model.id, tiers);
        if (model.canonical_slug) nextModels.set(model.canonical_slug, tiers);
      }
      if (nextModels.size > 0) {
        cache.models = nextModels;
        cache.fetchedAt = Date.now();
      }
    } catch {
      // Price resolution is best-effort and must never break request flow.
    } finally {
      clearTimeout(timeout);
      cache.inflight = null;
    }
  })();

  await cache.inflight;
}

export async function getOpenRouterModelPricing(
  modelName: string,
  promptTokens: number,
  apiKey?: string,
): Promise<OpenRouterModelPricing | null> {
  const cache = getCache();
  const isFresh = Date.now() - cache.fetchedAt < getTtlMs();

  if (!isFresh || cache.models.size === 0) {
    await refreshCache(apiKey);
  }

  const tiers = cache.models.get(modelName);
  const tier = tiers ? selectTier(tiers, promptTokens) : null;
  if (!tier) return null;

  return {
    promptPricePerTokenUsd: tier.promptPricePerTokenUsd,
    completionPricePerTokenUsd: tier.completionPricePerTokenUsd,
    requestPriceUsd: tier.requestPriceUsd,
  };
}

