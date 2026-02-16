export interface KnowledgeConfig {
  layerEnabled: boolean;
  ledgerEnabled: boolean;
  episodeEnabled: boolean;
  retrievalEnabled: boolean;
  maxContextTokens: number;
  ingestIntervalMs: number;
}

type EnvLike = Record<string, string | undefined>;

const MIN_CONTEXT_TOKENS = 200;
const MAX_CONTEXT_TOKENS = 8000;
const MIN_INGEST_INTERVAL_MS = 60_000;
const MAX_INGEST_INTERVAL_MS = 3_600_000;

export const KNOWLEDGE_DEFAULT_CONFIG: KnowledgeConfig = {
  layerEnabled: false,
  ledgerEnabled: false,
  episodeEnabled: false,
  retrievalEnabled: false,
  maxContextTokens: 4000,
  ingestIntervalMs: 600_000,
};

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  if (!normalized) return fallback;
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function clampNumber(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

export function resolveKnowledgeConfig(env: EnvLike = process.env as EnvLike): KnowledgeConfig {
  return {
    layerEnabled: parseBoolean(env.KNOWLEDGE_LAYER_ENABLED, KNOWLEDGE_DEFAULT_CONFIG.layerEnabled),
    ledgerEnabled: parseBoolean(
      env.KNOWLEDGE_LEDGER_ENABLED,
      KNOWLEDGE_DEFAULT_CONFIG.ledgerEnabled,
    ),
    episodeEnabled: parseBoolean(
      env.KNOWLEDGE_EPISODE_ENABLED,
      KNOWLEDGE_DEFAULT_CONFIG.episodeEnabled,
    ),
    retrievalEnabled: parseBoolean(
      env.KNOWLEDGE_RETRIEVAL_ENABLED,
      KNOWLEDGE_DEFAULT_CONFIG.retrievalEnabled,
    ),
    maxContextTokens: clampNumber(
      env.KNOWLEDGE_MAX_CONTEXT_TOKENS,
      KNOWLEDGE_DEFAULT_CONFIG.maxContextTokens,
      MIN_CONTEXT_TOKENS,
      MAX_CONTEXT_TOKENS,
    ),
    ingestIntervalMs: clampNumber(
      env.KNOWLEDGE_INGEST_INTERVAL_MS,
      KNOWLEDGE_DEFAULT_CONFIG.ingestIntervalMs,
      MIN_INGEST_INTERVAL_MS,
      MAX_INGEST_INTERVAL_MS,
    ),
  };
}

export function getKnowledgeConfig(): KnowledgeConfig {
  return resolveKnowledgeConfig();
}
