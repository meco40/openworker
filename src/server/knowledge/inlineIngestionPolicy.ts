type EnvLike = Record<string, string | undefined>;

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  if (!normalized) return fallback;
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

export function isInlineKnowledgeIngestionEnabled(env: EnvLike = process.env as EnvLike): boolean {
  return parseBoolean(env.KNOWLEDGE_INLINE_INGESTION_ENABLED, false);
}

export function isKnowledgePreIngestOnRecallEnabled(
  env: EnvLike = process.env as EnvLike,
): boolean {
  return parseBoolean(env.KNOWLEDGE_PRE_INGEST_ON_RECALL, false);
}
