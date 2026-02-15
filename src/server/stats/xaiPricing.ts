interface XaiModelPricePerMillionUsd {
  prompt: number;
  completion: number;
}

export interface XaiModelPricing {
  promptPricePerTokenUsd: number;
  completionPricePerTokenUsd: number;
  requestPriceUsd: number;
}

const TOKENS_PER_MILLION = 1_000_000;

const XAI_LANGUAGE_MODEL_PRICES_PER_MILLION_USD: Record<string, XaiModelPricePerMillionUsd> = {
  'grok-4-1-fast-reasoning': { prompt: 0.2, completion: 0.5 },
  'grok-4-1-fast-non-reasoning': { prompt: 0.2, completion: 0.5 },
  'grok-code-fast-1': { prompt: 0.2, completion: 1.5 },
  'grok-4-fast-reasoning': { prompt: 0.2, completion: 0.5 },
  'grok-4-fast-non-reasoning': { prompt: 0.2, completion: 0.5 },
  'grok-4-0709': { prompt: 3, completion: 15 },
  'grok-3-mini': { prompt: 0.3, completion: 0.5 },
  'grok-3': { prompt: 3, completion: 15 },
  'grok-2-vision-1212': { prompt: 2, completion: 10 },
};

const XAI_MODEL_ALIASES: Record<string, string> = {
  'grok-4': 'grok-4-0709',
};

function normalizeModelName(modelName: string): string {
  return modelName.trim().toLowerCase();
}

function resolveModelName(modelName: string): string | null {
  if (!modelName) return null;

  const normalized = normalizeModelName(modelName);
  const unprefixed = normalized.startsWith('x-ai/') ? normalized.slice('x-ai/'.length) : normalized;
  const canonical = XAI_MODEL_ALIASES[unprefixed] ?? unprefixed;

  return XAI_LANGUAGE_MODEL_PRICES_PER_MILLION_USD[canonical] ? canonical : null;
}

export async function getXaiModelPricing(modelName: string): Promise<XaiModelPricing | null> {
  const resolved = resolveModelName(modelName);
  if (!resolved) return null;

  const pricePerMillion = XAI_LANGUAGE_MODEL_PRICES_PER_MILLION_USD[resolved];
  return {
    promptPricePerTokenUsd: Math.max(0, pricePerMillion.prompt / TOKENS_PER_MILLION),
    completionPricePerTokenUsd: Math.max(0, pricePerMillion.completion / TOKENS_PER_MILLION),
    requestPriceUsd: 0,
  };
}
