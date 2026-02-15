export interface KnowledgeConfig {
  layerEnabled: boolean;
  ledgerEnabled: boolean;
  episodeEnabled: boolean;
  retrievalEnabled: boolean;
  maxContextTokens: number;
  ingestIntervalMs: number;
}

const DEFAULT_MAX_CONTEXT_TOKENS = 1200;
const MIN_MAX_CONTEXT_TOKENS = 256;
const MAX_MAX_CONTEXT_TOKENS = 4000;

const DEFAULT_INGEST_INTERVAL_MS = 600_000;
const MIN_INGEST_INTERVAL_MS = 60_000;
const MAX_INGEST_INTERVAL_MS = 3_600_000;

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function parseBoundedInt(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const normalized = (value || '').trim();
  if (!/^\d+$/.test(normalized)) return fallback;
  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return clamp(parsed, min, max);
}

export function resolveKnowledgeConfig(env: NodeJS.ProcessEnv = process.env): KnowledgeConfig {
  return {
    layerEnabled: parseBoolean(env.KNOWLEDGE_LAYER_ENABLED, false),
    ledgerEnabled: parseBoolean(env.KNOWLEDGE_LEDGER_ENABLED, false),
    episodeEnabled: parseBoolean(env.KNOWLEDGE_EPISODE_ENABLED, false),
    retrievalEnabled: parseBoolean(env.KNOWLEDGE_RETRIEVAL_ENABLED, false),
    maxContextTokens: parseBoundedInt(
      env.KNOWLEDGE_MAX_CONTEXT_TOKENS,
      DEFAULT_MAX_CONTEXT_TOKENS,
      MIN_MAX_CONTEXT_TOKENS,
      MAX_MAX_CONTEXT_TOKENS,
    ),
    ingestIntervalMs: parseBoundedInt(
      env.KNOWLEDGE_INGEST_INTERVAL_MS,
      DEFAULT_INGEST_INTERVAL_MS,
      MIN_INGEST_INTERVAL_MS,
      MAX_INGEST_INTERVAL_MS,
    ),
  };
}
